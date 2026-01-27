import { prisma } from '../db.js';

function sanitizeUser(user) {
	if (!user) return user;
	// Never expose passwordHash (or similar) in API responses
	// eslint-disable-next-line no-unused-vars
	const { passwordHash, ...safeUser } = user;
	return safeUser;
}

/**
 * Get the full user profile for a given userId.
 *
 * Hides sensitive fields like passwordHash from the returned object.
 */
export async function getUserProfileById(userId) {
	if (!userId) {
		const err = new Error('userId is required');
		err.code = 'USER_ID_REQUIRED';
		err.statusCode = 400;
		throw err;
	}

	const user = await prisma.user.findUnique({
		where: { id: userId },
		include: {
			address: true,
			socials: true,
		},
	});

	if (!user) {
		const err = new Error('User not found');
		err.code = 'USER_NOT_FOUND';
		err.statusCode = 404;
		throw err;
	}

	return sanitizeUser(user);
}

