import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCustomer,
  getCustomer,
  createSubscription,
  getSubscription,
  updateSubscription,
  deleteSubscription,
  cancelSubscriptionAtNextCycle,
  getPayment,
  listPaymentsBySubscription,
} from '../../src/billing/asaas-client.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const sandboxConfig = { apiKey: 'test-key', env: 'sandbox' };
const productionConfig = { apiKey: 'prod-key', env: 'production' };

const SANDBOX_BASE = 'https://api-sandbox.asaas.com/v3';
const PRODUCTION_BASE = 'https://api.asaas.com/v3';


function makeSuccessResponse(body) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  };
}

function makeErrorResponse(status, body = { errors: [{ description: 'Bad request' }] }) {
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

function makeMockFetch(response) {
  return vi.fn().mockResolvedValue(response);
}

// ─── Helper: extract call args ─────────────────────────────────────────────────

function getCall(mockFetch) {
  const [url, options] = mockFetch.mock.calls[0];
  return { url, ...options };
}

// ─── Base URL resolution ───────────────────────────────────────────────────────

describe('Base URL resolution', () => {
  it('uses sandbox URL for env=sandbox', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'cust-1' }));
    await createCustomer(mockFetch, sandboxConfig, { name: 'Test', email: 'test@example.com' });
    const { url } = getCall(mockFetch);
    expect(url).toContain(SANDBOX_BASE);
  });

  it('uses production URL for env=production', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'cust-1' }));
    await createCustomer(mockFetch, productionConfig, { name: 'Test', email: 'test@example.com' });
    const { url } = getCall(mockFetch);
    expect(url).toContain(PRODUCTION_BASE);
  });

  it('falls back to sandbox for unknown env', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'cust-1' }));
    await createCustomer(mockFetch, { apiKey: 'k', env: 'unknown' }, { name: 'Test', email: 'test@example.com' });
    const { url } = getCall(mockFetch);
    expect(url).toContain(SANDBOX_BASE);
  });
});

// ─── Headers ──────────────────────────────────────────────────────────────────

describe('Request headers', () => {
  it('sends required headers on every request', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'cust-1' }));
    await createCustomer(mockFetch, sandboxConfig, { name: 'Test', email: 'test@example.com' });
    const { headers } = getCall(mockFetch);
    expect(headers['access_token']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBe('Treinoway/1.0');
  });
});

// ─── createCustomer ───────────────────────────────────────────────────────────

describe('createCustomer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends POST /customers with name and email', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'cust-1', name: 'João' }));
    const result = await createCustomer(mockFetch, sandboxConfig, { name: 'João', email: 'joao@example.com' });

    const { url, method, body } = getCall(mockFetch);
    expect(url).toBe(`${SANDBOX_BASE}/customers`);
    expect(method).toBe('POST');
    const parsed = JSON.parse(body);
    expect(parsed.name).toBe('João');
    expect(parsed.email).toBe('joao@example.com');
    expect(result.id).toBe('cust-1');
  });

  it('includes cpfCnpj and phone when provided', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'cust-1' }));
    await createCustomer(mockFetch, sandboxConfig, {
      name: 'João',
      email: 'joao@example.com',
      cpfCnpj: '12345678901',
      phone: '11999999999',
    });

    const { body } = getCall(mockFetch);
    const parsed = JSON.parse(body);
    expect(parsed.cpfCnpj).toBe('12345678901');
    expect(parsed.phone).toBe('11999999999');
  });
});

// ─── getCustomer ──────────────────────────────────────────────────────────────

describe('getCustomer', () => {
  it('sends GET /customers/:id', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'cust-abc' }));
    await getCustomer(mockFetch, sandboxConfig, 'cust-abc');

    const { url, method } = getCall(mockFetch);
    expect(url).toBe(`${SANDBOX_BASE}/customers/cust-abc`);
    expect(method).toBe('GET');
  });
});

// ─── createSubscription ───────────────────────────────────────────────────────

describe('createSubscription', () => {
  it('sends POST /subscriptions with all required fields', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'sub-1', invoiceUrl: 'https://asaas.com/pay/sub-1' }));

    const result = await createSubscription(mockFetch, sandboxConfig, {
      customer: 'cust-abc',
      billingType: 'PIX',
      value: 49.90,
      nextDueDate: '2026-05-16',
      cycle: 'MONTHLY',
      description: 'Treinoway PRO — Mensal',
      externalReference: 'tier:PRO:trainer:trainer-uuid-1',
    });

    const { url, method, body } = getCall(mockFetch);
    expect(url).toBe(`${SANDBOX_BASE}/subscriptions`);
    expect(method).toBe('POST');
    const parsed = JSON.parse(body);
    expect(parsed.customer).toBe('cust-abc');
    expect(parsed.billingType).toBe('PIX');
    expect(parsed.value).toBe(49.90);
    expect(parsed.nextDueDate).toBe('2026-05-16');
    expect(parsed.cycle).toBe('MONTHLY');
    expect(parsed.externalReference).toBe('tier:PRO:trainer:trainer-uuid-1');
    expect(result.invoiceUrl).toBe('https://asaas.com/pay/sub-1');
  });
});

// ─── getSubscription ──────────────────────────────────────────────────────────

describe('getSubscription', () => {
  it('sends GET /subscriptions/:id', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'sub-1' }));
    await getSubscription(mockFetch, sandboxConfig, 'sub-1');

    const { url, method } = getCall(mockFetch);
    expect(url).toBe(`${SANDBOX_BASE}/subscriptions/sub-1`);
    expect(method).toBe('GET');
  });
});

// ─── updateSubscription ───────────────────────────────────────────────────────

describe('updateSubscription', () => {
  it('sends PUT /subscriptions/:id with updates in body', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'sub-1' }));
    await updateSubscription(mockFetch, sandboxConfig, 'sub-1', { value: 99.90 });

    const { url, method, body } = getCall(mockFetch);
    expect(url).toBe(`${SANDBOX_BASE}/subscriptions/sub-1`);
    expect(method).toBe('PUT');
    expect(JSON.parse(body)).toEqual({ value: 99.90 });
  });
});

// ─── deleteSubscription ───────────────────────────────────────────────────────

describe('deleteSubscription', () => {
  it('sends DELETE /subscriptions/:id with no body', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ deleted: true }));
    await deleteSubscription(mockFetch, sandboxConfig, 'sub-1');

    const { url, method, body } = getCall(mockFetch);
    expect(url).toBe(`${SANDBOX_BASE}/subscriptions/sub-1`);
    expect(method).toBe('DELETE');
    expect(body).toBeUndefined();
  });
});

// ─── cancelSubscriptionAtNextCycle ────────────────────────────────────────────

describe('cancelSubscriptionAtNextCycle', () => {
  it('sends PUT /subscriptions/:id with status=INACTIVE', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'sub-1' }));
    await cancelSubscriptionAtNextCycle(mockFetch, sandboxConfig, 'sub-1');

    const { url, method, body } = getCall(mockFetch);
    expect(url).toBe(`${SANDBOX_BASE}/subscriptions/sub-1`);
    expect(method).toBe('PUT');
    expect(JSON.parse(body)).toEqual({ status: 'INACTIVE' });
  });
});

// ─── getPayment ───────────────────────────────────────────────────────────────

describe('getPayment', () => {
  it('sends GET /payments/:id', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'pay-1' }));
    await getPayment(mockFetch, sandboxConfig, 'pay-1');

    const { url, method } = getCall(mockFetch);
    expect(url).toBe(`${SANDBOX_BASE}/payments/pay-1`);
    expect(method).toBe('GET');
  });
});

// ─── listPaymentsBySubscription ───────────────────────────────────────────────

describe('listPaymentsBySubscription', () => {
  it('sends GET /payments?subscription=:id', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ data: [] }));
    await listPaymentsBySubscription(mockFetch, sandboxConfig, 'sub-1');

    const { url } = getCall(mockFetch);
    expect(url).toContain(`${SANDBOX_BASE}/payments`);
    expect(url).toContain('subscription=sub-1');
  });

  it('includes optional status and pagination params', async () => {
    const mockFetch = makeMockFetch(makeSuccessResponse({ data: [] }));
    await listPaymentsBySubscription(mockFetch, sandboxConfig, 'sub-1', { status: 'CONFIRMED', limit: 10, offset: 5 });

    const { url } = getCall(mockFetch);
    expect(url).toContain('status=CONFIRMED');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=5');
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('Error handling', () => {
  it('throws AppError with ASAAS_API_ERROR when fetch throws', async () => {
    const networkError = new Error('network timeout');
    const mockFetch = vi.fn().mockRejectedValue(networkError);

    await expect(createCustomer(mockFetch, sandboxConfig, { name: 'Test', email: 'test@test.com' }))
      .rejects.toMatchObject({
        error: 'ASAAS_API_ERROR',
        messageCode: 'platformPlan.checkoutFailed',
        httpStatus: 502,
      });
  });

  it('throws AppError with ASAAS_API_ERROR for non-2xx response', async () => {
    const mockFetch = makeMockFetch(makeErrorResponse(400, { errors: [{ description: 'Invalid data' }] }));

    await expect(createCustomer(mockFetch, sandboxConfig, { name: 'Test', email: 'test@test.com' }))
      .rejects.toMatchObject({
        error: 'ASAAS_API_ERROR',
        messageCode: 'platformPlan.checkoutFailed',
        httpStatus: 502,
        details: expect.objectContaining({ asaasStatus: 400 }),
      });
  });

  it('includes asaasBody in error details for non-2xx', async () => {
    const errorBody = { errors: [{ description: 'Customer not found' }] };
    const mockFetch = makeMockFetch(makeErrorResponse(404, errorBody));

    await expect(getCustomer(mockFetch, sandboxConfig, 'bad-id'))
      .rejects.toMatchObject({
        details: expect.objectContaining({ asaasBody: errorBody }),
      });
  });

  it('creates an AbortController for request timeout', async () => {
    // If fetch is called, an AbortController was created (we can verify via signal in call args)
    const mockFetch = makeMockFetch(makeSuccessResponse({ id: 'cust-1' }));
    await createCustomer(mockFetch, sandboxConfig, { name: 'Test', email: 'test@test.com' });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});
