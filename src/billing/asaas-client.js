/**
 * Asaas API client — DI-friendly wrapper around fetch.
 *
 * All functions accept (httpClient, config, ...args) so tests can inject a
 * mock httpClient. In production, pass the global `fetch`.
 *
 * config shape: { apiKey, env } where env is 'sandbox' | 'production'
 *
 * Asaas docs: https://docs.asaas.com
 */

import { AppError } from '../errors/app-error.js';

const REQUEST_TIMEOUT_MS = 10_000;

const BASE_URLS = Object.freeze({
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
});

function resolveBaseUrl(env) {
  return BASE_URLS[env] ?? BASE_URLS.sandbox;
}

function buildHeaders(apiKey) {
  return {
    'access_token': apiKey,
    'Content-Type': 'application/json',
    'User-Agent': 'Treinoway/1.0',
  };
}

async function request(httpClient, config, method, path, body) {
  const baseUrl = resolveBaseUrl(config.env);
  const url = `${baseUrl}${path}`;
  const headers = buildHeaders(config.apiKey);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await httpClient(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (fetchError) {
    clearTimeout(timeoutId);
    throw new AppError({
      httpStatus: 502,
      error: 'ASAAS_API_ERROR',
      messageCode: 'platformPlan.checkoutFailed',
      message: 'Failed to reach Asaas API',
      details: { cause: fetchError.message },
    });
  }
  clearTimeout(timeoutId);

  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new AppError({
      httpStatus: 502,
      error: 'ASAAS_API_ERROR',
      messageCode: 'platformPlan.checkoutFailed',
      message: `Asaas API returned ${response.status}`,
      details: { asaasStatus: response.status, asaasBody: responseBody },
    });
  }

  return responseBody;
}

export async function createCustomer(httpClient, config, { name, email, cpfCnpj, phone }) {
  return request(httpClient, config, 'POST', '/customers', {
    name,
    email,
    cpfCnpj: cpfCnpj ?? undefined,
    phone: phone ?? undefined,
  });
}

export async function getCustomer(httpClient, config, asaasCustomerId) {
  return request(httpClient, config, 'GET', `/customers/${asaasCustomerId}`);
}

export async function createSubscription(
  httpClient,
  config,
  { customer, billingType, value, nextDueDate, cycle, description, externalReference },
) {
  return request(httpClient, config, 'POST', '/subscriptions', {
    customer,
    billingType,
    value,
    nextDueDate,
    cycle,
    description,
    externalReference,
  });
}

export async function getSubscription(httpClient, config, subscriptionId) {
  return request(httpClient, config, 'GET', `/subscriptions/${subscriptionId}`);
}

export async function updateSubscription(httpClient, config, subscriptionId, updates) {
  return request(httpClient, config, 'PUT', `/subscriptions/${subscriptionId}`, updates);
}

export async function deleteSubscription(httpClient, config, subscriptionId) {
  return request(httpClient, config, 'DELETE', `/subscriptions/${subscriptionId}`);
}

/**
 * Cancel a subscription at the end of the current billing period.
 * Asaas supports this via updateSubscription with status: 'INACTIVE'.
 */
export async function cancelSubscriptionAtNextCycle(httpClient, config, subscriptionId) {
  return updateSubscription(httpClient, config, subscriptionId, { status: 'INACTIVE' });
}

export async function getPayment(httpClient, config, paymentId) {
  return request(httpClient, config, 'GET', `/payments/${paymentId}`);
}

export async function listPaymentsBySubscription(httpClient, config, subscriptionId, options = {}) {
  const params = new URLSearchParams({ subscription: subscriptionId });
  if (options.status) params.set('status', options.status);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  return request(httpClient, config, 'GET', `/payments?${params.toString()}`);
}
