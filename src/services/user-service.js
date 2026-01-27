import { prisma } from '../db.js';
import { Roles } from '../constants/roles.js';

function toUserProfile(user) {
	if (!user) return null;

	return {
		id: user.id,
		email: user.email,
		roles: user.roles,
		status: user.status,
		firstName: user.firstName,
		lastName: user.lastName,
		birthDate: user.birthDate,
		avatarUrl: user.avatarUrl,
		address: user.address,
		socials: user.socials,
		preferences: user.preferences
			? {
					activeProfile: user.preferences.activeProfile,
					createdAt: user.preferences.createdAt,
					updatedAt: user.preferences.updatedAt,
				}
			: null,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
	};
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
		select: {
			id: true,
			email: true,
			roles: true,
			status: true,
			firstName: true,
			lastName: true,
			birthDate: true,
			avatarUrl: true,
			address: true,
			socials: true,
			preferences: {
				select: {
					activeProfile: true,
					createdAt: true,
					updatedAt: true,
				},
			},
			createdAt: true,
			updatedAt: true,
		},
	});

	if (!user) {
		const err = new Error('User not found');
		err.code = 'USER_NOT_FOUND';
		err.statusCode = 404;
		throw err;
	}

	return toUserProfile(user);
}

export async function setActiveProfileToTrainer(userId) {
	if (!userId) {
		const err = new Error('userId is required');
		err.code = 'USER_ID_REQUIRED';
		err.statusCode = 400;
		throw err;
	}

	// Ensure the user has the TRAINER role in addition to any existing roles.
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: { roles: true },
	});

	if (!user) {
		const err = new Error('User not found');
		err.code = 'USER_NOT_FOUND';
		err.statusCode = 404;
		throw err;
	}

	const currentRoles = Array.isArray(user.roles) ? user.roles : [];
	if (!currentRoles.includes(Roles.TRAINER)) {
		await prisma.user.update({
			where: { id: userId },
			data: {
				roles: {
					set: [...currentRoles, Roles.TRAINER],
				},
			},
		});
	}

	const preferences = await prisma.userPreferences.upsert({
		where: { userId },
		create: { userId, activeProfile: 'trainer' },
		update: { activeProfile: 'trainer' },
	});

	return preferences;
}

