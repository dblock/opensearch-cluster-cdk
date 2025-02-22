/* Copyright OpenSearch Contributors
SPDX-License-Identifier: Apache-2.0

The OpenSearch Contributors require contributions made to
this file be licensed under the Apache-2.0 license or a
compatible open source license. */

import {
  AmazonLinuxCpuType,
  AmazonLinuxGeneration,
  CloudFormationInit,
  InitCommand,
  InitElement,
  InitPackage,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  ISecurityGroup,
  IVpc,
  MachineImage,
  SubnetType,
} from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { AutoScalingGroup, BlockDeviceVolume, Signals } from 'aws-cdk-lib/aws-autoscaling';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  CfnOutput, RemovalPolicy, Stack, StackProps, Tags,
} from 'aws-cdk-lib';
import { NetworkListener, NetworkLoadBalancer, Protocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { join } from 'path';
import { readFileSync } from 'fs';
import { dump, load } from 'js-yaml';
import { InstanceTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { CloudwatchAgent } from '../cloudwatch/cloudwatch-agent';
import { nodeConfig } from '../opensearch-config/node-config';

export interface infraProps extends StackProps{
    readonly vpc: IVpc,
    readonly securityGroup: ISecurityGroup,
    readonly opensearchVersion: string,
    readonly cpuArch: string,
    readonly cpuType: AmazonLinuxCpuType,
    readonly securityDisabled: boolean,
    readonly minDistribution: boolean,
    readonly distributionUrl: string,
    readonly dashboardsUrl: string,
    readonly singleNodeCluster: boolean,
    readonly managerNodeCount: number,
    readonly dataNodeCount: number,
    readonly ingestNodeCount: number,
    readonly clientNodeCount: number,
    readonly mlNodeCount: number,
    readonly dataNodeStorage: number,
    readonly mlNodeStorage: number,
    readonly jvmSysPropsString?: string,
    readonly additionalConfig?: string,
    readonly dataEc2InstanceType: InstanceType,
    readonly mlEc2InstanceType: InstanceType,
    readonly use50PercentHeap: boolean,
    readonly isInternal: boolean,
}

export class InfraStack extends Stack {
  constructor(scope: Stack, id: string, props: infraProps) {
    super(scope, id, props);
    let opensearchListener: NetworkListener;
    let dashboardsListener: NetworkListener;
    let managerAsgCapacity: number;
    let dataAsgCapacity: number;
    let clientNodeAsg: AutoScalingGroup;
    let seedConfig: string;
    let hostType: InstanceType;
    let singleNodeInstance: Instance;

    const clusterLogGroup = new LogGroup(this, 'opensearchLogGroup', {
      logGroupName: `${id}LogGroup/opensearch.log`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const instanceRole = new Role(this, 'instanceRole', {
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ReadOnlyAccess'),
        ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
    });

    const singleNodeInstanceType = (props.cpuType === AmazonLinuxCpuType.X86_64)
      ? InstanceType.of(InstanceClass.R5, InstanceSize.XLARGE) : InstanceType.of(InstanceClass.R6G, InstanceSize.XLARGE);

    const defaultInstanceType = (props.cpuType === AmazonLinuxCpuType.X86_64)
      ? InstanceType.of(InstanceClass.C5, InstanceSize.XLARGE) : InstanceType.of(InstanceClass.C6G, InstanceSize.XLARGE);

    const nlb = new NetworkLoadBalancer(this, 'clusterNlb', {
      vpc: props.vpc,
      internetFacing: (!props.isInternal),
      crossZoneEnabled: true,
    });

    if (!props.securityDisabled && !props.minDistribution) {
      opensearchListener = nlb.addListener('opensearch', {
        port: 443,
        protocol: Protocol.TCP,
      });
    } else {
      opensearchListener = nlb.addListener('opensearch', {
        port: 80,
        protocol: Protocol.TCP,
      });
    }

    if (props.dashboardsUrl !== 'undefined') {
      dashboardsListener = nlb.addListener('dashboards', {
        port: 8443,
        protocol: Protocol.TCP,
      });
    }

    if (props.singleNodeCluster) {
      console.log('Single node value is true, creating single node configurations');
      singleNodeInstance = new Instance(this, 'single-node-instance', {
        vpc: props.vpc,
        instanceType: singleNodeInstanceType,
        machineImage: MachineImage.latestAmazonLinux({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          cpuType: props.cpuType,
        }),
        role: instanceRole,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: props.securityGroup,
        blockDevices: [{
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(props.dataNodeStorage, { deleteOnTermination: true }),
        }],
        init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props)),
        initOptions: {
          ignoreFailures: false,
        },
      });
      Tags.of(singleNodeInstance).add('role', 'client');

      opensearchListener.addTargets('single-node-target', {
        port: 9200,
        targets: [new InstanceTarget(singleNodeInstance)],
      });

      if (props.dashboardsUrl !== 'undefined') {
        // @ts-ignore
        dashboardsListener.addTargets('single-node-osd-target', {
          port: 5601,
          targets: [new InstanceTarget(singleNodeInstance)],
        });
      }
      new CfnOutput(this, 'private-ip', {
        value: singleNodeInstance.instancePrivateIp,
      });
    } else {
      if (props.managerNodeCount > 0) {
        managerAsgCapacity = props.managerNodeCount - 1;
        dataAsgCapacity = props.dataNodeCount;
      } else {
        managerAsgCapacity = props.managerNodeCount;
        dataAsgCapacity = props.dataNodeCount - 1;
      }

      if (managerAsgCapacity > 0) {
        const managerNodeAsg = new AutoScalingGroup(this, 'managerNodeAsg', {
          vpc: props.vpc,
          instanceType: defaultInstanceType,
          machineImage: MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: props.cpuType,
          }),
          role: instanceRole,
          maxCapacity: managerAsgCapacity,
          minCapacity: managerAsgCapacity,
          desiredCapacity: managerAsgCapacity,
          vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          },
          securityGroup: props.securityGroup,
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true }),
          }],
          init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, 'manager')),
          initOptions: {
            ignoreFailures: false,
          },
          signals: Signals.waitForAll(),
        });
        Tags.of(managerNodeAsg).add('role', 'manager');

        seedConfig = 'seed-manager';
      } else {
        seedConfig = 'seed-data';
      }

      const seedNodeAsg = new AutoScalingGroup(this, 'seedNodeAsg', {
        vpc: props.vpc,
        instanceType: (seedConfig === 'seed-manager') ? defaultInstanceType : props.dataEc2InstanceType,
        machineImage: MachineImage.latestAmazonLinux({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          cpuType: props.cpuType,
        }),
        role: instanceRole,
        maxCapacity: 1,
        minCapacity: 1,
        desiredCapacity: 1,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: props.securityGroup,
        blockDevices: [{
          deviceName: '/dev/xvda',
          // eslint-disable-next-line max-len
          volume: (seedConfig === 'seed-manager') ? BlockDeviceVolume.ebs(50, { deleteOnTermination: true }) : BlockDeviceVolume.ebs(props.dataNodeStorage, { deleteOnTermination: true }),
        }],
        init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, seedConfig)),
        initOptions: {
          ignoreFailures: false,
        },
        signals: Signals.waitForAll(),
      });
      Tags.of(seedNodeAsg).add('role', 'manager');

      const dataNodeAsg = new AutoScalingGroup(this, 'dataNodeAsg', {
        vpc: props.vpc,
        instanceType: props.dataEc2InstanceType,
        machineImage: MachineImage.latestAmazonLinux({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          cpuType: props.cpuType,
        }),
        role: instanceRole,
        maxCapacity: dataAsgCapacity,
        minCapacity: dataAsgCapacity,
        desiredCapacity: dataAsgCapacity,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: props.securityGroup,
        blockDevices: [{
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(props.dataNodeStorage, { deleteOnTermination: true }),
        }],
        init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, 'data')),
        initOptions: {
          ignoreFailures: false,
        },
        signals: Signals.waitForAll(),
      });
      Tags.of(dataNodeAsg).add('role', 'data');

      if (props.clientNodeCount === 0) {
        clientNodeAsg = dataNodeAsg;
      } else {
        clientNodeAsg = new AutoScalingGroup(this, 'clientNodeAsg', {
          vpc: props.vpc,
          instanceType: defaultInstanceType,
          machineImage: MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: props.cpuType,
          }),
          role: instanceRole,
          maxCapacity: props.clientNodeCount,
          minCapacity: props.clientNodeCount,
          desiredCapacity: props.clientNodeCount,
          vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          },
          securityGroup: props.securityGroup,
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true }),
          }],
          init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, 'client')),
          initOptions: {
            ignoreFailures: false,
          },
          signals: Signals.waitForAll(),
        });
        Tags.of(clientNodeAsg).add('cluster', scope.stackName);
      }

      Tags.of(clientNodeAsg).add('role', 'client');

      if (props.mlNodeCount > 0) {
        const mlNodeAsg = new AutoScalingGroup(this, 'mlNodeAsg', {
          vpc: props.vpc,
          instanceType: props.mlEc2InstanceType,
          machineImage: MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: props.cpuType,
          }),
          role: instanceRole,
          maxCapacity: props.mlNodeCount,
          minCapacity: props.mlNodeCount,
          desiredCapacity: props.mlNodeCount,
          vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          },
          securityGroup: props.securityGroup,
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(props.mlNodeStorage, { deleteOnTermination: true }),
          }],
          init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, 'ml')),
          initOptions: {
            ignoreFailures: false,
          },
          signals: Signals.waitForAll(),
        });

        Tags.of(mlNodeAsg).add('role', 'ml-node');
      }

      opensearchListener.addTargets('opensearchTarget', {
        port: 9200,
        targets: [clientNodeAsg],
      });

      if (props.dashboardsUrl !== 'undefined') {
        // @ts-ignore
        dashboardsListener.addTargets('dashboardsTarget', {
          port: 5601,
          targets: [clientNodeAsg],
        });
      }
    }

    new CfnOutput(this, 'loadbalancer-url', {
      value: nlb.loadBalancerDnsName,
    });
  }

  private static getCfnInitElement(scope: Stack, logGroup: LogGroup, props: infraProps, nodeType?: string): InitElement[] {
    const configFileDir = join(__dirname, '../opensearch-config');
    let opensearchConfig: string;

    const cfnInitConfig : InitElement[] = [
      InitPackage.yum('amazon-cloudwatch-agent'),
      CloudwatchAgent.asInitFile('/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
        {
          agent: {
            metrics_collection_interval: 60,
            logfile: '/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log',
            omit_hostname: true,
            debug: false,
          },
          metrics: {
            metrics_collected: {
              cpu: {
                measurement: [
                  // eslint-disable-next-line max-len
                  'usage_active', 'usage_guest', 'usage_guest_nice', 'usage_idle', 'usage_iowait', 'usage_irq', 'usage_nice', 'usage_softirq', 'usage_steal', 'usage_system', 'usage_user', 'time_active', 'time_iowait', 'time_system', 'time_user',
                ],
              },
              disk: {
                measurement: [
                  'free', 'total', 'used', 'used_percent', 'inodes_free', 'inodes_used', 'inodes_total',
                ],
              },
              diskio: {
                measurement: [
                  'reads', 'writes', 'read_bytes', 'write_bytes', 'read_time', 'write_time', 'io_time',
                ],
              },
              mem: {
                measurement: [
                  'active', 'available', 'available_percent', 'buffered', 'cached', 'free', 'inactive', 'total', 'used', 'used_percent',
                ],
              },
              net: {
                measurement: [
                  'bytes_sent', 'bytes_recv', 'drop_in', 'drop_out', 'err_in', 'err_out', 'packets_sent', 'packets_recv',
                ],
              },
            },
          },
          logs: {
            logs_collected: {
              files: {
                collect_list: [
                  {
                    file_path: `/home/ec2-user/opensearch/logs/${scope.stackName}-${scope.account}-${scope.region}.log`,
                    log_group_name: `${logGroup.logGroupName.toString()}`,
                    // eslint-disable-next-line no-template-curly-in-string
                    log_stream_name: '{instance_id}',
                    auto_removal: true,
                  },
                ],
              },
            },
            force_flush_interval: 5,
          },
        }),
      InitCommand.shellCommand('set -ex;/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a stop'),
      // eslint-disable-next-line max-len
      InitCommand.shellCommand('set -ex;/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s'),
      InitCommand.shellCommand('set -ex; sudo echo "vm.max_map_count=262144" >> /etc/sysctl.conf;sudo sysctl -p'),
      InitCommand.shellCommand(`set -ex;mkdir opensearch; curl -L ${props.distributionUrl} -o opensearch.tar.gz;`
                + 'tar zxf opensearch.tar.gz -C opensearch --strip-components=1; chown -R ec2-user:ec2-user opensearch;', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }),
      InitCommand.shellCommand('sleep 15'),
    ];

    // Add opensearch.yml config
    if (props.singleNodeCluster) {
      const fileContent: any = load(readFileSync(`${configFileDir}/single-node-base-config.yml`, 'utf-8'));

      fileContent['cluster.name'] = `${scope.stackName}-${scope.account}-${scope.region}`;

      console.log(dump(fileContent).toString());
      opensearchConfig = dump(fileContent).toString();
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "${opensearchConfig}" > config/opensearch.yml`,
        {
          cwd: '/home/ec2-user',
        }));
    } else {
      const baseConfig: any = load(readFileSync(`${configFileDir}/multi-node-base-config.yml`, 'utf-8'));

      baseConfig['cluster.name'] = `${scope.stackName}-${scope.account}-${scope.region}`;
      const commonConfig = dump(baseConfig).toString();
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "${commonConfig}" > config/opensearch.yml`,
        {
          cwd: '/home/ec2-user',
        }));

      if (nodeType != null) {
        const nodeTypeConfig = nodeConfig.get(nodeType);
        const nodeConfigData = dump(nodeTypeConfig).toString();
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "${nodeConfigData}" >> config/opensearch.yml`,
          {
            cwd: '/home/ec2-user',
          }));
      }

      if (props.distributionUrl.includes('artifacts.opensearch.org') && !props.minDistribution) {
        cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; echo "y"|sudo -u ec2-user bin/opensearch-plugin install discovery-ec2', {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
      } else {
        cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; echo "y"|sudo -u ec2-user bin/opensearch-plugin install '
            + `https://ci.opensearch.org/ci/dbc/distribution-build-opensearch/${props.opensearchVersion}/latest/linux/${props.cpuArch}`
            + `/tar/builds/opensearch/core-plugins/discovery-ec2-${props.opensearchVersion}.zip`, {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
      }
    }

    // add config to disable security if required
    if (props.securityDisabled && !props.minDistribution) {
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; echo "plugins.security.disabled: true" >> config/opensearch.yml',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
    }

    // Check if there are any jvm properties being passed
    // @ts-ignore
    if (props.jvmSysPropsString.toString() !== 'undefined') {
      // @ts-ignore
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex; cd opensearch; jvmSysPropsList=$(echo "${props.jvmSysPropsString.toString()}" | tr ',' '\\n');`
      + 'for sysProp in $jvmSysPropsList;do echo "-D$sysProp" >> config/jvm.options;done',
      {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    // Check if JVM Heap Memory is set. Default is 1G in the jvm.options file
    // @ts-ignore
    if (props.use50PercentHeap) {
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex; cd opensearch;
      totalMem=\`expr $(free -g | awk '/^Mem:/{print $2}') + 1\`;
      heapSizeInGb=\`expr $totalMem / 2\`;
      if [ $heapSizeInGb -lt 32 ];then minHeap="-Xms"$heapSizeInGb"g";maxHeap="-Xmx"$heapSizeInGb"g";else minHeap="-Xms32g";maxHeap="-Xmx32g";fi
      sed -i -e "s/^-Xms[0-9a-z]*$/$minHeap/g" config/jvm.options;
      sed -i -e "s/^-Xmx[0-9a-z]*$/$maxHeap/g" config/jvm.options;`, {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    // @ts-ignore
    if (props.additionalConfig.toString() !== 'undefined') {
      // @ts-ignore
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex; cd opensearch; echo "${props.additionalConfig}">>config/opensearch.yml`,
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
    }

    // final run command based on whether the distribution type is min or bundle
    if (props.minDistribution) { // using (stackProps.minDistribution) condition is not working when false value is being sent
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; sudo -u ec2-user nohup ./bin/opensearch >> install.log 2>&1 &',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
    } else {
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; sudo -u ec2-user nohup ./opensearch-tar-install.sh >> install.log 2>&1 &',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
    }

    // If OSD Url is present
    if (props.dashboardsUrl !== 'undefined') {
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;mkdir opensearch-dashboards; curl -L ${props.dashboardsUrl} -o opensearch-dashboards.tar.gz;`
          + 'tar zxf opensearch-dashboards.tar.gz -C opensearch-dashboards --strip-components=1; chown -R ec2-user:ec2-user opensearch-dashboards;', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));

      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch-dashboards;echo "server.host: 0.0.0.0" >> config/opensearch_dashboards.yml',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));

      if (props.securityDisabled && !props.minDistribution) {
        cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch-dashboards;'
            + './bin/opensearch-dashboards-plugin remove securityDashboards --allow-root;'
            + 'sed -i /^opensearch_security/d config/opensearch_dashboards.yml;'
            + 'sed -i \'s/https/http/\' config/opensearch_dashboards.yml',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
      }

      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch-dashboards;'
          + 'sudo -u ec2-user nohup ./bin/opensearch-dashboards > dashboard_install.log 2>&1 &', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    return cfnInitConfig;
  }
}
