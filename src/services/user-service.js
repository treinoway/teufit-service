import { prisma } from '../db.js';
import { Roles } from '../constants/roles.js';
import { buildUserSelect } from '../helpers/user-query-builder.js';

function toUserProfile(user) {
	if (!user) return null;

	// Start with base user fields
	const profile = {
		id: user.id,
		email: user.email,
		roles: user.roles,
		status: user.status,
		firstName: user.firstName,
		lastName: user.lastName,
		gender: user.gender,
		birthDate: user.birthDate,
		avatarUrl: user.avatarUrl,
	};

	// Only include relations that were loaded (not undefined)
	// This allows for selective loading via query parameters
	if (user.address !== undefined) {
		profile.address = user.address ? {
			id: user.address.id,
			line1: user.address.line1,
			line2: user.address.line2,
			neighborhood: user.address.neighborhood,
			city: user.address.city,
			state: user.address.state,
			stateCode: user.address.stateCode,
			country: user.address.country,
			countryCode: user.address.countryCode,
			postalCode: user.address.postalCode,
		} : null;
	}

	if (user.socials !== undefined) {
		profile.socials = user.socials ? {
			id: user.socials.id,
			instagram: user.socials.instagram,
			whatsapp: user.socials.whatsapp,
			x: user.socials.x,
			threads: user.socials.threads,
			youtube: user.socials.youtube,
			linkedin: user.socials.linkedin,
			facebook: user.socials.facebook,
		} : null;
	}

	if (user.preferences !== undefined) {
		profile.preferences = user.preferences ? {
			activeProfile: user.preferences.activeProfile,
			rawPreferences: user.preferences.rawPreferences,
		} : null;
	}

	return profile;
}

/**
 * Get user profile with selective relation loading.
 *
 * @param {string} userId - User ID
 * @param {string[]} includeRelations - Relations to include (default: [])
 * @returns {Promise<Object>} User profile with requested relations
 *
 * @example
 * // Minimal payload (no relations)
 * getUserProfileById('user123', [])
 *
 * @example
 * // Include specific relations
 * getUserProfileById('user123', ['address', 'socials'])
 */
export async function getUserProfileById(userId, includeRelations = []) {
	if (!userId) {
		const err = new Error('userId is required');
		err.code = 'USER_ID_REQUIRED';
		err.statusCode = 400;
		throw err;
	}

	// Build dynamic select based on requested relations
	const select = buildUserSelect(includeRelations);

	const user = await prisma.user.findUnique({
		where: { id: userId },
		select,
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

/**
 * Update user profile including personal data, address, and socials.
 * All fields are optional - only provided fields will be updated.
 */
export async function updateUserProfile(userId, data) {
	try {
if (!userId) {
		const err = new Error('userId is required');
		err.code = 'USER_ID_REQUIRED';
		err.statusCode = 400;
		throw err;
	}

	// Verify user exists
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: { id: true },
	});

	if (!user) {
		const err = new Error('User not found');
		err.code = 'USER_NOT_FOUND';
		err.statusCode = 404;
		throw err;
	}

	const { address, socials, preferences, firstName, lastName, birthDate, avatarUrl, gender } = data;

	// Build user update data
	const userUpdateData = {};
	if (firstName !== undefined) userUpdateData.firstName = firstName;
	if (lastName !== undefined) userUpdateData.lastName = lastName;
	if (gender !== undefined) userUpdateData.gender = gender;
	if (avatarUrl !== undefined) userUpdateData.avatarUrl = avatarUrl;
	if (birthDate !== undefined) {
		// Parse birthDate string to Date object
		userUpdateData.birthDate = birthDate ? new Date(birthDate) : null;
	}

	// Prepare nested updates for address and socials
	const addressUpdate = address ? {
		upsert: {
			create: {
				line1: address.line1 || null,
				line2: address.line2 || null,
				neighborhood: address.neighborhood || null,
				city: address.city || null,
				state: address.state || null,
				stateCode: address.stateCode || null,
				country: address.country || null,
				countryCode: address.countryCode || null,
				postalCode: address.postalCode || null,
			},
			update: {
				...(address.line1 !== undefined && { line1: address.line1 }),
				...(address.line2 !== undefined && { line2: address.line2 }),
				...(address.neighborhood !== undefined && { neighborhood: address.neighborhood }),
				...(address.city !== undefined && { city: address.city }),
				...(address.state !== undefined && { state: address.state }),
				...(address.stateCode !== undefined && { stateCode: address.stateCode }),
				...(address.country !== undefined && { country: address.country }),
				...(address.countryCode !== undefined && { countryCode: address.countryCode }),
				...(address.postalCode !== undefined && { postalCode: address.postalCode }),
			},
		},
	} : undefined;

	const socialsUpdate = socials ? {
		upsert: {
			create: {
				instagram: socials.instagram || null,
				whatsapp: socials.whatsapp || null,
				x: socials.x || null,
				threads: socials.threads || null,
				youtube: socials.youtube || null,
				linkedin: socials.linkedin || null,
				facebook: socials.facebook || null,
			},
			update: {
				...(socials.instagram !== undefined && { instagram: socials.instagram }),
				...(socials.whatsapp !== undefined && { whatsapp: socials.whatsapp }),
				...(socials.x !== undefined && { x: socials.x }),
				...(socials.threads !== undefined && { threads: socials.threads }),
				...(socials.youtube !== undefined && { youtube: socials.youtube }),
				...(socials.linkedin !== undefined && { linkedin: socials.linkedin }),
				...(socials.facebook !== undefined && { facebook: socials.facebook }),
			},
		},
	} : undefined;

	const preferencesUpdate = preferences ? {
		upsert: {
			create: {
				...(preferences.rawPreferences !== undefined && { rawPreferences: preferences.rawPreferences }),
			},
			update: {
				...(preferences.rawPreferences !== undefined && { rawPreferences: preferences.rawPreferences }),
			},
		},
	} : undefined;

	// Perform update with nested upserts
	const updatedUser = await prisma.user.update({
		where: { id: userId },
		data: {
			...userUpdateData,
			...(addressUpdate && { address: addressUpdate }),
			...(socialsUpdate && { socials: socialsUpdate }),
			...(preferencesUpdate && { preferences: preferencesUpdate }),
		},
		select: {
			id: true,
			email: true,
			roles: true,
			status: true,
			firstName: true,
			lastName: true,
			gender: true,
			birthDate: true,
			avatarUrl: true,
			address: {
				select: {
					id: true,
					line1: true,
					line2: true,
					neighborhood: true,
					city: true,
					state: true,
					stateCode: true,
					country: true,
					countryCode: true,
					postalCode: true,
				},
			},
			socials: {
				select: {
					id: true,
					instagram: true,
					whatsapp: true,
					x: true,
					threads: true,
					youtube: true,
					linkedin: true,
					facebook: true,
				},
			},
			preferences: {
				select: {
					activeProfile: true,
					rawPreferences: true,
				},
			},
		},
	});

	return toUserProfile(updatedUser);
	}catch (err) {
		console.error('Error in updateUserProfile:', err);
		throw err;
	}
	
}

