import {UserPresence} from './enums';


/**
 * Represents one user.
 */
export interface IUser {
	/** Image URI for avatar / profile picture. */
	avatar: string;

	/** Email Address */
	email: string;

	/** Premium Account */
	hasPremium: boolean;

	/** Full name. */
	name: string;

	/** @see UserPresence. */
	status: UserPresence;

	/** Username. */
	username: string;
}
