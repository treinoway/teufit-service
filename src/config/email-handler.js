'use strict'

import { Resend } from 'resend';

const resendApiKey = process.env.RESEND_API_KEY;
const disableEmail = process.env.DISABLE_EMAIL === 'true';
/**
 * Email handler configuration and setup.
 */

class EmailHandler {
    constructor() {
        // Allow explicit disabling of email sending via env var,
        // and keep tests safe even without an API key.
        if (disableEmail) {
            this.resendClient = null;
            return;
        }

        if (!resendApiKey) {
            throw new Error('RESEND_API_KEY environment variable is required to send emails');
        }

        this.resendClient = new Resend(resendApiKey);
    }

        sendResetPasswordEmail({to, passwordToken}) {
        const subject = 'Password Reset Request';
        const htmlContent = `
            <p>Use this code to reset your password:</p>
            <p>${passwordToken}</p>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'onboarding@resend.dev',
            to,
            html: htmlContent,
            subject: subject,
        });
    }
}

export default new EmailHandler();