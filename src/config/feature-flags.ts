const parseBoolean = (value: string | undefined, defaultValue = false): boolean => {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
};

export const featureFlags = {
  get structuredLogging(): boolean {
    return parseBoolean(process.env.FF_STRUCTURED_LOGGING, true);
  },
  get billingHttpMock(): boolean {
    return parseBoolean(process.env.FF_BILLING_HTTP_MOCK, false);
  },
  get authBypassForTests(): boolean {
    return parseBoolean(process.env.FF_AUTH_BYPASS_FOR_TESTS, false);
  },
  get mockPaymentProvider(): boolean {
    return parseBoolean(process.env.FF_PAYMENT_PROVIDER_MOCK, false);
  },
  get normalizedResponseAdapter(): boolean {
    return parseBoolean(process.env.FF_NORMALIZED_RESPONSE_ADAPTER, false);
  },
  get billingDomainShadowMode(): boolean {
    return parseBoolean(process.env.FF_BILLING_DOMAIN_SHADOW_MODE, false);
  },
  get billingDomainCutover(): boolean {
    return parseBoolean(process.env.FF_BILLING_DOMAIN_CUTOVER, false);
  },
  get sourceOfTruthReconciliationEnabled(): boolean {
    return parseBoolean(process.env.FF_SOT_RECONCILIATION_ENABLED, false);
  },
  get sourceOfTruthReconciliationRepair(): boolean {
    return parseBoolean(process.env.FF_SOT_RECONCILIATION_REPAIR, false);
  },
  get adminControllerServiceCutover(): boolean {
    return parseBoolean(process.env.FF_ADMIN_CONTROLLER_SERVICE_CUTOVER, false);
  },
  get creatorControllerServiceCutover(): boolean {
    return parseBoolean(process.env.FF_CREATOR_CONTROLLER_SERVICE_CUTOVER, false);
  },
  get videoWebhookServiceCutover(): boolean {
    return parseBoolean(process.env.FF_VIDEO_WEBHOOK_SERVICE_CUTOVER, false);
  },
  get paymentControllerServiceCutover(): boolean {
    return parseBoolean(process.env.FF_PAYMENT_CONTROLLER_SERVICE_CUTOVER, false);
  },
};

