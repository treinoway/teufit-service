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
        const subject = 'Treinoway - Pedido de alteração de senha';
        const htmlContent = `
            <p>Utilize este código de 6 dígitos para redefinir sua senha (ele expira em 15 minutos):</p>
            <p><strong>${passwordToken}</strong></p>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'noreply@contato.treinoway.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }
}

export default new EmailHandler();