'use strict';
/**
 * AcAuthStack (Phase 7, ADR 0006): Appliance Clinic's own Cognito user pool, so AC authentication no longer depends on
 * the S4R pool. Created new (nothing is imported), L1 resources only, Retain everywhere.
 *
 *   - User pool `applianceclinic`: email is the username; only administrators create users (no self sign-up);
 *     a strong password policy; email recovery; deletion protection.
 *   - App client `applianceclinic-web`: no secret. whichpart-api signs in server side with ADMIN_USER_PASSWORD_AUTH,
 *     exactly as it does against the S4R pool today. The authorization-code flow is enabled for the Cognito managed
 *     sign-in pages only, where an invited user sets their own password (no password ever passes through an
 *     operator) and where a user can reset a forgotten one.
 *   - Group `admin`: AC admin authority is membership of this group in this pool, and nothing else.
 *   - Domain `applianceclinic-admin.auth.eu-west-1.amazoncognito.com` (a Cognito prefix domain: no DNS, no certificate,
 *     no CloudFront of ours).
 */
const cdk = require('aws-cdk-lib');
const { aws_cognito: cognito } = cdk;
const { retain } = require('./common');

const AUTH = {
  poolName: 'applianceclinic',
  clientName: 'applianceclinic-web',
  adminGroup: 'admin',
  domainPrefix: 'applianceclinic-admin',
  // The managed sign-in pages redirect here after a password is set; the site ignores the code.
  callbackUrl: 'https://applianceclinic.ai/',
};

class AuthStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const pool = retain(new cognito.CfnUserPool(this, 'UserPool', {
      userPoolName: AUTH.poolName,
      userPoolTier: 'LITE',
      usernameAttributes: ['email'],
      autoVerifiedAttributes: ['email'],
      schema: [{ name: 'email', attributeDataType: 'String', required: true, mutable: true }],
      adminCreateUserConfig: {
        allowAdminCreateUserOnly: true,
        inviteMessageTemplate: {
          emailSubject: 'Your Appliance Clinic admin account',
          emailMessage: 'An Appliance Clinic admin account has been created for {username}. Your temporary password is {####}. '
            + 'It expires in 3 days. Set your own password on the Appliance Clinic admin sign-in page, using the link your administrator sends you.',
        },
      },
      policies: {
        passwordPolicy: {
          minimumLength: 14, requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSymbols: true,
          temporaryPasswordValidityDays: 3,
        },
      },
      accountRecoverySetting: { recoveryMechanisms: [{ name: 'verified_email', priority: 1 }] },
      mfaConfiguration: 'OFF',
      deletionProtection: 'ACTIVE',
      userPoolTags: { 'ac:owner': 'appliance-clinic' },
    }));
    const client = retain(new cognito.CfnUserPoolClient(this, 'WebClient', {
      userPoolId: pool.ref,
      clientName: AUTH.clientName,
      generateSecret: false,
      explicitAuthFlows: ['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      preventUserExistenceErrors: 'ENABLED',
      enableTokenRevocation: true,
      accessTokenValidity: 60,
      idTokenValidity: 60,
      refreshTokenValidity: 1,
      tokenValidityUnits: { accessToken: 'minutes', idToken: 'minutes', refreshToken: 'days' },
      supportedIdentityProviders: ['COGNITO'],
      allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthFlows: ['code'],
      allowedOAuthScopes: ['openid', 'email'],
      callbackUrLs: [AUTH.callbackUrl],
      logoutUrLs: [AUTH.callbackUrl],
    }));
    retain(new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: pool.ref,
      groupName: AUTH.adminGroup,
      description: 'Appliance Clinic administrators (ADR 0006). Membership is the only source of AC admin authority.',
    }));
    retain(new cognito.CfnUserPoolDomain(this, 'Domain', { userPoolId: pool.ref, domain: AUTH.domainPrefix }));

    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.ref });
    new cdk.CfnOutput(this, 'UserPoolArn', { value: pool.attrArn });
    new cdk.CfnOutput(this, 'ClientId', { value: client.ref });
    this.templateOptions.description = `${id}: Appliance Clinic authentication (Phase 7, ADR 0006). Retain on every resource.`;
  }
}

module.exports = { AuthStack, AUTH };
