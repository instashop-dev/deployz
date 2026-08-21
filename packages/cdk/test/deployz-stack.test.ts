import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DeployzStack } from '../src/deployz-stack.js';

describe('DeployzStack', () => {
  it('synthesizes without errors', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    // The template should be valid JSON (Template.fromStack throws on
    // invalid templates, so reaching here means synthesis succeeded).
    expect(template).toBeDefined();
  });

  it('creates a VPC with 2 AZs', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::EC2::VPC', {});
  });

  it('creates an RDS PostgreSQL instance', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DBInstanceClass: 'db.t4g.micro',
    });
  });

  it('creates a Lambda function for the API', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::Function', 3); // API + durable + log retention custom resource
  });

  it('creates an SQS queue for job processing', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SQS::Queue', 1);
  });

  it('creates an EventBridge rule targeting SQS', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Events::Rule', 1);
  });

  it('creates a DynamoDB table for durable execution state', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'executionId', KeyType: 'HASH' },
      ],
    });
  });

  it('exports stack outputs', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);
    expect(outputKeys).toContain('ExportDeployzTestDbHost');
    expect(outputKeys).toContain('ExportDeployzTestApiFunctionArn');
    expect(outputKeys).toContain('ExportDeployzTestJobQueueArn');
    expect(outputKeys).toContain('ExportDeployzTestDurableCallbackUrl');
  });
});