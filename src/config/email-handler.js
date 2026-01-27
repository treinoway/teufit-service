'use strict'

import { Resend } from 'resend';

const resendApiKey = process.env.RESEND_API_KEY;
/**
 * Email handler configuration and setup.
 */

class EmailHandler {
    constructor() {
        this.resendClient = new Resend(resendApiKey);
    }

        sendResetPasswordEmail({to, passwordToken}) {
        const subject = 'Password Reset Request';
        const htmlContent = `
            <p>Use this code to reset your password:</p>
            <p>${passwordToken}</p>
        `;

        return this.resendClient.emails.send({
            from: 'onboarding@resend.dev',
            to,
            html: htmlContent,
            subject: subject,
        });
    }
}

export default new EmailHandler();