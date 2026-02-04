import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { buildServer } from '../../api/server.js';

describe('e2e: address flows', () => {
	let app;
	let accessToken;

	beforeAll(async () => {
		// Ensure secrets are set for JWT and session plugins in tests
		process.env.SESSION_SECRET =
			process.env.SESSION_SECRET || 'test-session-secret-key-for-e2e-tests-012345';
		process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

		// Provide dummy Google OAuth configuration so fastify-oauth2 can register
		process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || 'test-google-client-id';
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || 'test-google-client-secret';
		process.env.GOOGLE_OAUTH_CALLBACK_URL =
			process.env.GOOGLE_OAUTH_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

		app = await buildServer({ logger: false });

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

	afterAll(async () => {
		if (app) {
			await app.close();
		}
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
		});

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
		});

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
			// Schema validation happens first, so we get Fastify's validation error
			expect(body).toHaveProperty('error');
			expect(body.error).toBe('Bad Request');
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
				url: '/postal-code?code=99999999',
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
		});

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
		});

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
		});
	});
});
