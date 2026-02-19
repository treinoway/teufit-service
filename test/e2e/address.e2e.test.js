import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

describe('e2e: address flows', () => {
	let app;
	let accessToken;

	beforeAll(async () => {
		app = await setupApp();
	});

	afterAll(async () => {
		if (app) {
			await app.close();
		}
	});

	beforeEach(async () => {
		// Clean database between tests to keep them isolated
		await cleanDatabase();

		// Sign up a test user and get access token for authenticated requests
		const email = `test-address-${Date.now()}@example.com`;
		const password = 'TestPassword123!';
		
		const signupResponse = await app.inject({
			method: 'POST',
			url: '/auth/signup',
			payload: { email, password },
		});
		
		accessToken = signupResponse.json().token.accessToken;
	});

	describe('GET /postal-code', () => {
		it('successfully fetches address for valid postal code with formatting', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/postal-code?code=01310-100',
				headers: {
					authorization: `Bearer ${accessToken}`,
				},
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();

			expect(body).toMatchObject({
				line1: expect.any(String),
				neighborhood: expect.any(String),
				city: 'São Paulo',
				stateCode: 'SP',
				country: 'Brasil',
				countryCode: 'BR',
				postalCode: '01310-100',
			});
			expect(body.line1).toContain('Paulista');
		}, 15000);

		it('successfully fetches address for valid postal code without formatting', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/postal-code?code=01310100',
				headers: {
					authorization: `Bearer ${accessToken}`,
				},
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();

			expect(body).toMatchObject({
				city: 'São Paulo',
				stateCode: 'SP',
				country: 'Brasil',
				countryCode: 'BR',
			});
		}, 15000);

		it('returns 401 when not authenticated', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/postal-code?code=01310-100',
			});

			expect(response.statusCode).toBe(401);
			const body = response.json();
			expect(body).toHaveProperty('error');
			expect(body.error).toBe('Authentication required');
		});

		it('returns 400 when postal code parameter is missing', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/postal-code',
				headers: {
					authorization: `Bearer ${accessToken}`,
				},
			});

			expect(response.statusCode).toBe(400);
			const body = response.json();
			expect(body).toHaveProperty('error');
		});

		it('returns 400 when postal code format is invalid (too short)', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/postal-code?code=123',
				headers: {
					authorization: `Bearer ${accessToken}`,
				},
			});

			expect(response.statusCode).toBe(400);
			const body = response.json();
			// Schema validation happens before handler logic and is normalized globally.
			expect(body).toMatchObject({
				error: 'VALIDATION_ERROR',
				messageCode: 'validation.failed',
			});
			expect(body.details).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						field: 'code',
						messageCode: expect.stringContaining('validation.code'),
					}),
				])
			);
		});

		it('returns 400 when postal code format is invalid (too long)', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/postal-code?code=123456789',
				headers: {
					authorization: `Bearer ${accessToken}`,
				},
			});

			expect(response.statusCode).toBe(400);
			const body = response.json();
			expect(body).toMatchObject({
				error: 'INVALID_POSTAL_CODE_FORMAT',
			});
		});

		it('returns 404 when postal code is not found', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/postal-code?code=11111111', // CEP that returns "erro": true from ViaCEP
				headers: {
					authorization: `Bearer ${accessToken}`,
				},
			});

			expect(response.statusCode).toBe(404);
			const body = response.json();
			expect(body).toMatchObject({
				error: 'POSTAL_CODE_NOT_FOUND',
				message: 'Postal code not found',
			});
		}, 15000);

		it('handles postal codes with special characters', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/postal-code?code=01.310-100',
				headers: {
					authorization: `Bearer ${accessToken}`,
				},
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.city).toBe('São Paulo');
		}, 15000);

		it('returns proper address schema structure', async () => {
			const response = await app.inject({
				method: 'GET',
				url: '/postal-code?code=20040-020', // Rio de Janeiro - Centro
				headers: {
					authorization: `Bearer ${accessToken}`,
				},
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();

			// Verify the response matches the address schema
			expect(body).toHaveProperty('line1');
			expect(body).toHaveProperty('line2');
			expect(body).toHaveProperty('neighborhood');
			expect(body).toHaveProperty('city');
			expect(body).toHaveProperty('state');
			expect(body).toHaveProperty('stateCode');
			expect(body).toHaveProperty('country');
			expect(body).toHaveProperty('countryCode');
			expect(body).toHaveProperty('postalCode');

			// Verify the values are as expected
			expect(body.city).toBe('Rio de Janeiro');
			expect(body.stateCode).toBe('RJ');
			expect(body.country).toBe('Brasil');
			expect(body.countryCode).toBe('BR');
		}, 15000);
	});
});
