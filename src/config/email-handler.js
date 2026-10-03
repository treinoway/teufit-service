'use strict'

import { Resend } from 'resend';
import { parseBool } from '../helpers/env.js';
import config from '../../config/index.js';

const resendApiKey = process.env.RESEND_API_KEY;
const disableEmail = parseBool(process.env.DISABLE_EMAIL, false);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;

/**
 * Makes user-controlled text safe for an email subject: replaces CR/LF and other
 * control characters with a space (blocks header injection / multi-line subjects)
 * and collapses whitespace. Returns '' when nothing printable remains.
 */
export function sanitizeSubjectText(value) {
    return String(value ?? '').replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

function renderStoreButton({ href, label }) {
    return `<a href="${escapeHtml(href)}" style="display: inline-block; background-color: #0F1B2D; color: #ffffff; font-size: 14px; font-weight: 700; text-decoration: none; padding: 14px 24px; border-radius: 12px; margin: 4px;">${label}</a>`;
}

function renderStoreButtonsBlock() {
    return `
                            <table role="presentation" style="width: 100%; margin: 24px 0 8px; border-collapse: collapse;">
                                <tr>
                                    <td align="center">
                                        <p style="margin: 0 0 12px; color: #4b5563; font-size: 15px; line-height: 1.6; text-align: center;">
                                            Baixe o app TeuFit:
                                        </p>
                                        ${renderStoreButton({ href: config.stores.appStoreUrl, label: 'App Store' })}
                                        ${renderStoreButton({ href: config.stores.playStoreUrl, label: 'Google Play' })}
                                    </td>
                                </tr>
                            </table>`;
}

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
        const subject = 'TeuFit - Código para redefinir tua senha';
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Redefinir senha</title>
    <link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:opsz,wght@6..12,400;6..12,700;6..12,800&display=swap" rel="stylesheet">
</head>
<body style="margin: 0; padding: 0; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F2F5F9;">
    <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">Usa este código para redefinir tua senha. Ele expira em 15 minutos.</div>
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F2F5F9;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #ffffff; box-shadow: 0 10px 18px rgba(16, 84, 178, 0.08); border-radius: 16px; overflow: hidden;">

                    <!-- Header -->
                    <tr>
                        <td style="background: #ffffff; padding: 36px 30px 28px; text-align: center; border-bottom: 1px solid #e2e8f0;">
                            <img src="https://teufit.com.br/img/teufit-lockup.png" alt="TeuFit" width="180" style="display: block; margin: 0 auto; width: 180px; max-width: 60%; height: auto; border: 0; color: #1054B2; font-size: 24px; font-weight: 800; letter-spacing: 0.03em; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 44px 40px;">
                            <h2 style="margin: 0 0 12px; color: #0F1B2D; font-size: 22px; font-weight: 800; text-align: center;">
                                Redefinir tua senha
                            </h2>

                            <p style="margin: 0 0 28px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Usa o código abaixo para criar uma nova senha. Ele expira em <strong>15 minutos</strong>.
                            </p>

                            <!-- Code -->
                            <table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; margin: 0 0 28px;">
                                <tr>
                                    <td align="center" style="text-align: center; background-color: #D6E5F8; border-radius: 16px; padding: 24px;">
                                        <span style="color: #1054B2; font-size: 36px; font-weight: 800; letter-spacing: 0.35em; padding-left: 0.35em; font-family: 'Nunito Sans', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${passwordToken}</span>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.7; text-align: center;">
                                Se você não pediu essa alteração, pode ignorar este e-mail.<br>
                                Tua senha continua a mesma.
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f7fafc; padding: 24px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                © 2026 TeuFit. Todos os direitos reservados.
                            </p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'noreply@teufit.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }

    sendWaitlistConfirmationEmail({to}) {
        const subject = '[TeuFit] Que bom ter você conosco! 🎉';
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bem-vindo ao TeuFit</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Exo 2', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #ffffff; box-shadow: 0 10px 18px rgba(30, 111, 219, 0.08); border-radius: 16px; overflow: hidden;">
                    
                    <!-- Header -->
                    <tr>
                        <td style="background: #0f172a; padding: 40px 30px; text-align: center;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">
                                TEUFIT
                            </h1>
                            <p style="margin: 10px 0 0; color: #e5e7eb; font-size: 16px;">
                                Seu treino, seu caminho
                            </p>
                        </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding: 50px 40px;">
                            <h2 style="margin: 0 0 20px; color: #020617; font-size: 24px; font-weight: 700; text-align: center;">
                                Você está na lista de espera! 🎉
                            </h2>
                            
                            <p style="margin: 0 0 16px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Seja <strong>aluno</strong> ou <strong>treinador</strong>, você está entre os primeiros a fazer parte de uma plataforma que vai transformar a forma como treinos são organizados e acompanhados.
                            </p>
                            
                            <p style="margin: 0 0 30px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Em breve, você terá acesso exclusivo a todas as funcionalidades do TeuFit!
                            </p>
                            
                            <!-- Features Box -->
                            <table role="presentation" style="width: 100%; margin: 0 0 30px; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 0;">
                                        <!-- For Students -->
                                        <table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; background-color: #1e6fdb; border-radius: 12px;">
                                            <tr>
                                                <td style="padding: 24px;">
                                                    <p style="margin: 0 0 14px; color: #ffffff; font-size: 17px; font-weight: 700;">
                                                        📱 Para alunos
                                                    </p>
                                                    <p style="margin: 0; color: #ffffff; font-size: 14px; line-height: 1.7; font-weight: 600; opacity: 0.95;">
                                                        ✨ Encontre treinadores qualificados<br>
                                                        📊 Acompanhe sua evolução<br>
                                                        💪 Treinos personalizados para você<br>
                                                        🎯 Histórico de saúde organizado
                                                    </p>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                                
                                <!-- Spacing between cards -->
                                <tr>
                                    <td style="height: 16px; line-height: 16px; font-size: 16px;">&nbsp;</td>
                                </tr>
                                
                                <tr>
                                    <td style="padding: 0;">
                                        <!-- For Trainers -->
                                        <table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; background-color: #ff9a56; border-radius: 12px;">
                                            <tr>
                                                <td style="padding: 24px;">
                                                    <p style="margin: 0 0 14px; color: #ffffff; font-size: 17px; font-weight: 700;">
                                                        🏋️ Para treinadores
                                                    </p>
                                                    <p style="margin: 0; color: #ffffff; font-size: 14px; line-height: 1.7; font-weight: 600; opacity: 0.95;">
                                                        🎨 Identidade visual personalizada<br>
                                                        👥 Gestão da carteira de alunos<br>
                                                        💰 Controle financeiro simplificado<br>
                                                        ⭐ Marketplace com avaliações
                                                    </p>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            
                            <p style="margin: 0 0 16px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                <strong>Fique de olho na sua caixa de entrada!</strong><br>
                                Enviaremos um e-mail assim que estivermos prontos para recebê-lo(a) na plataforma.
                            </p>
                            
                            <p style="margin: 30px 0 0; color: #6b7280; font-size: 15px; line-height: 1.6; text-align: center;">
                                Até breve,<br>
                                <strong style="color: #4b5563;">Equipe TeuFit</strong>
                            </p>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f7fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0 0 8px; color: #6b7280; font-size: 13px;">
                                Em breve nas lojas de aplicativos
                            </p>
                            <p style="margin: 0 0 12px; color: #9ca3af; font-size: 12px;">
                                iOS • Android
                            </p>
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                © 2026 TeuFit. Todos os direitos reservados.
                            </p>
                        </td>
                    </tr>
                    
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'onboarding@teufit.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }

    sendStudentLinkedEmail({to, trainerName}) {
        const teamLabel = trainerName ? `time de ${escapeHtml(trainerName)}` : 'time do seu treinador';
        const subject = '[TeuFit] Bem-vindo ao teste fechado! 🚀';
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Você foi vinculado a um time</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F1F5F9;">
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F1F5F9;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #ffffff; box-shadow: 0 10px 24px rgba(16, 84, 178, 0.10); border-radius: 20px; overflow: hidden;">

                    <!-- Header -->
                    <tr>
                        <td style="background: linear-gradient(160deg, #1054B2, #0D47A1); padding: 40px 30px; text-align: center;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">
                                TEUFIT
                            </h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 50px 40px;">
                            <!-- Beta badge -->
                            <table role="presentation" style="width: 100%; margin: 0 0 20px; border-collapse: collapse;">
                                <tr>
                                    <td align="center">
                                        <span style="display: inline-block; background-color: #FFECDC; color: #1E293B; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 6px 14px; border-radius: 999px;">
                                            🚀 Acesso antecipado • Teste fechado
                                        </span>
                                    </td>
                                </tr>
                            </table>

                            <h2 style="margin: 0 0 20px; color: #020617; font-size: 24px; font-weight: 700; text-align: center;">
                                Você está no teste fechado do TeuFit!
                            </h2>

                            <p style="margin: 0 0 16px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Você foi vinculado ao ${teamLabel} e é uma das primeiras pessoas a usar o TeuFit. Estamos muito felizes em ter você nessa fase inicial com a gente.
                            </p>

                            <!-- What to expect -->
                            <table role="presentation" style="width: 100%; margin: 24px 0; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 0;">
                                        <table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; background-color: #1e6fdb; border-radius: 12px;">
                                            <tr>
                                                <td style="padding: 24px;">
                                                    <p style="margin: 0 0 14px; color: #ffffff; font-size: 17px; font-weight: 700;">
                                                        O que esperar desta fase
                                                    </p>
                                                    <p style="margin: 0; color: #ffffff; font-size: 14px; line-height: 1.8; font-weight: 600; opacity: 0.95;">
                                                        🐛 Alguns bugs podem aparecer — é esperado e faz parte do processo.<br>
                                                        💬 Seu feedback molda o produto: conte o que funciona e o que pode melhorar.<br>
                                                        🤝 Sua participação é muito importante para deixar o TeuFit cada vez melhor.
                                                    </p>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 0 0 4px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Estamos ansiosos pelos seus feedbacks. Conte com a gente!
                            </p>
${renderStoreButtonsBlock()}

                            <p style="margin: 30px 0 0; color: #6b7280; font-size: 15px; line-height: 1.6; text-align: center;">
                                Bons treinos,<br>
                                <strong style="color: #4b5563;">Equipe TeuFit</strong>
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f7fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                © 2026 TeuFit. Todos os direitos reservados.
                            </p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'onboarding@teufit.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }

    sendTrainerInviteEmail({to, code, inviteUrl, invitedByName}) {
        const inviterLabel = invitedByName ? `${escapeHtml(invitedByName)} te convidou` : 'Você foi convidado(a)';
        const subject = '[TeuFit] Seu convite para o teste fechado 🚀';
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Seu convite TeuFit</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F1F5F9;">
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F1F5F9;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #ffffff; box-shadow: 0 10px 24px rgba(16, 84, 178, 0.10); border-radius: 20px; overflow: hidden;">

                    <!-- Header -->
                    <tr>
                        <td style="background: linear-gradient(160deg, #1054B2, #0D47A1); padding: 40px 30px; text-align: center;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">
                                TEUFIT
                            </h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 50px 40px;">
                            <!-- Beta badge -->
                            <table role="presentation" style="width: 100%; margin: 0 0 20px; border-collapse: collapse;">
                                <tr>
                                    <td align="center">
                                        <span style="display: inline-block; background-color: #FFECDC; color: #1E293B; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 6px 14px; border-radius: 999px;">
                                            🚀 Acesso antecipado • Teste fechado
                                        </span>
                                    </td>
                                </tr>
                            </table>

                            <h2 style="margin: 0 0 20px; color: #020617; font-size: 24px; font-weight: 700; text-align: center;">
                                ${inviterLabel} para o TeuFit!
                            </h2>

                            <p style="margin: 0 0 30px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Você foi convidado(a) a fazer parte do teste fechado do TeuFit como treinador(a). Clique no botão abaixo para entrar — se ainda não tiver conta, você poderá criar uma com este mesmo e-mail.
                            </p>

                            <!-- CTA -->
                            <table role="presentation" style="width: 100%; margin: 0 0 28px; border-collapse: collapse;">
                                <tr>
                                    <td align="center">
                                        <a href="${inviteUrl}" style="display: inline-block; background-color: #1054B2; color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; padding: 16px 40px; border-radius: 14px; text-transform: uppercase; letter-spacing: 0.06em;">
                                            Aceitar convite
                                        </a>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 0 0 12px; color: #6b7280; font-size: 14px; line-height: 1.6; text-align: center;">
                                Ou insira este código manualmente na tela de convite:
                            </p>

                            <!-- Code -->
                            <table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; margin: 0 0 28px;">
                                <tr>
                                    <td align="center" style="text-align: center; background-color: #D6E5F8; border-radius: 16px; padding: 20px;">
                                        <span style="color: #1054B2; font-size: 22px; font-weight: 800; letter-spacing: 0.12em; font-family: 'Nunito Sans', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${code}</span>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 0; color: #9ca3af; font-size: 13px; line-height: 1.6; text-align: center;">
                                Este convite expira em 7 dias e só pode ser usado com este e-mail.
                            </p>

                            <p style="margin: 30px 0 0; color: #6b7280; font-size: 15px; line-height: 1.6; text-align: center;">
                                Bons treinos,<br>
                                <strong style="color: #4b5563;">Equipe TeuFit</strong>
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f7fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                © 2026 TeuFit. Todos os direitos reservados.
                            </p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'onboarding@teufit.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }

    sendStudentInviteEmail({to, trainerName: rawTrainerName}) {
        const trainerName = sanitizeSubjectText(rawTrainerName);
        const teamLabel = trainerName ? escapeHtml(trainerName) : 'seu treinador';
        const subject = trainerName
            ? `[TeuFit] ${trainerName} convidou você para o time`
            : '[TeuFit] Você foi convidado para o time do seu treinador';
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Convite TeuFit</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F1F5F9;">
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F1F5F9;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #ffffff; box-shadow: 0 10px 24px rgba(16, 84, 178, 0.10); border-radius: 20px; overflow: hidden;">

                    <!-- Header -->
                    <tr>
                        <td style="background: linear-gradient(160deg, #1054B2, #0D47A1); padding: 40px 30px; text-align: center;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">
                                TEUFIT
                            </h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 50px 40px;">
                            <h2 style="margin: 0 0 20px; color: #020617; font-size: 24px; font-weight: 700; text-align: center;">
                                Você foi convidado para o time de ${teamLabel}
                            </h2>

                            <p style="margin: 0 0 16px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                ${teamLabel} está te esperando no TeuFit para acompanhar seus treinos.
                            </p>

                            <p style="margin: 0 0 16px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Baixe o app e crie sua conta usando <strong>este mesmo e-mail</strong>. Depois de confirmar seu e-mail, você entra no time automaticamente.
                            </p>
${renderStoreButtonsBlock()}

                            <p style="margin: 24px 0 0; color: #9ca3af; font-size: 13px; line-height: 1.6; text-align: center;">
                                Este convite expira em 30 dias.
                            </p>

                            <p style="margin: 30px 0 0; color: #6b7280; font-size: 15px; line-height: 1.6; text-align: center;">
                                Bons treinos,<br>
                                <strong style="color: #4b5563;">Equipe TeuFit</strong>
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f7fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                © 2026 TeuFit. Todos os direitos reservados.
                            </p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'onboarding@teufit.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }

    /**
     * Invite for a student who already has an account whose email is not yet
     * verified. One email carries both the invite and the verification code
     * (`code` is null when the code could not be issued: the user is told to
     * open the app and request one).
     */
    sendExistingUserStudentInviteEmail({to, trainerName: rawTrainerName, code}) {
        const trainerName = sanitizeSubjectText(rawTrainerName);
        const teamLabel = trainerName ? escapeHtml(trainerName) : 'seu treinador';
        const subject = trainerName
            ? `[TeuFit] ${trainerName} convidou você para o time`
            : '[TeuFit] Você foi convidado para o time do seu treinador';
        const codeBlock = code
            ? `
                            <p style="margin: 0 0 12px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Abra o app TeuFit e confirme seu e-mail com o código abaixo. Ele expira em <strong>30 minutos</strong>.
                            </p>

                            <table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; margin: 0 0 20px;">
                                <tr>
                                    <td align="center" style="text-align: center; background-color: #D6E5F8; border-radius: 16px; padding: 24px;">
                                        <span style="color: #1054B2; font-size: 36px; font-weight: 800; letter-spacing: 0.35em; padding-left: 0.35em; font-family: 'Nunito Sans', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${escapeHtml(code)}</span>
                                    </td>
                                </tr>
                            </table>`
            : `
                            <p style="margin: 0 0 20px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Abra o app TeuFit e confirme seu e-mail. Se o app não mostrar um código, peça um novo na tela de confirmação.
                            </p>`;
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Convite TeuFit</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F1F5F9;">
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F1F5F9;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #ffffff; box-shadow: 0 10px 24px rgba(16, 84, 178, 0.10); border-radius: 20px; overflow: hidden;">

                    <!-- Header -->
                    <tr>
                        <td style="background: linear-gradient(160deg, #1054B2, #0D47A1); padding: 40px 30px; text-align: center;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">
                                TEUFIT
                            </h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 50px 40px;">
                            <h2 style="margin: 0 0 20px; color: #020617; font-size: 24px; font-weight: 700; text-align: center;">
                                Você foi convidado para o time de ${teamLabel}
                            </h2>

                            <p style="margin: 0 0 16px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Você foi convidado para o time de <strong>${teamLabel}</strong>. Depois de confirmar seu e-mail, você entra no time automaticamente.
                            </p>
${codeBlock}
${renderStoreButtonsBlock()}

                            <p style="margin: 24px 0 0; color: #9ca3af; font-size: 13px; line-height: 1.6; text-align: center;">
                                Este convite expira em 30 dias.
                            </p>

                            <p style="margin: 30px 0 0; color: #6b7280; font-size: 15px; line-height: 1.6; text-align: center;">
                                Bons treinos,<br>
                                <strong style="color: #4b5563;">Equipe TeuFit</strong>
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f7fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                © 2026 TeuFit. Todos os direitos reservados.
                            </p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'onboarding@teufit.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }

    sendEmailVerificationEmail({to, code}) {
        const subject = '[TeuFit] Confirme seu e-mail';
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confirme seu e-mail</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F2F5F9;">
    <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">Use este código para confirmar seu e-mail. Ele expira em 30 minutos.</div>
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F2F5F9;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #ffffff; box-shadow: 0 10px 18px rgba(16, 84, 178, 0.08); border-radius: 16px; overflow: hidden;">

                    <!-- Header -->
                    <tr>
                        <td style="background: #ffffff; padding: 36px 30px 28px; text-align: center; border-bottom: 1px solid #e2e8f0;">
                            <img src="https://teufit.com.br/img/teufit-lockup.png" alt="TeuFit" width="180" style="display: block; margin: 0 auto; width: 180px; max-width: 60%; height: auto; border: 0; color: #1054B2; font-size: 24px; font-weight: 800; letter-spacing: 0.03em; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 44px 40px;">
                            <h2 style="margin: 0 0 12px; color: #0F1B2D; font-size: 22px; font-weight: 800; text-align: center;">
                                Confirme seu e-mail
                            </h2>

                            <p style="margin: 0 0 28px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Use o código abaixo para confirmar seu e-mail. Ele expira em <strong>30 minutos</strong>.
                            </p>

                            <!-- Code -->
                            <table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; margin: 0 0 28px;">
                                <tr>
                                    <td align="center" style="text-align: center; background-color: #D6E5F8; border-radius: 16px; padding: 24px;">
                                        <span style="color: #1054B2; font-size: 36px; font-weight: 800; letter-spacing: 0.35em; padding-left: 0.35em; font-family: 'Nunito Sans', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${escapeHtml(code)}</span>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.7; text-align: center;">
                                Se você não criou uma conta no TeuFit, pode ignorar este e-mail.
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f7fafc; padding: 24px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                © 2026 TeuFit. Todos os direitos reservados.
                            </p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'noreply@teufit.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }

    /**
     * Sent instead of a signup code when someone signs up with an email that
     * already has an account. The signup API answers the same either way (no
     * account enumeration), so this email is how the real owner finds out.
     */
    sendExistingAccountSignupEmail({to}) {
        const subject = '[TeuFit] Você já tem uma conta';
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Você já tem uma conta</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F2F5F9;">
    <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">Alguém tentou criar uma conta com este e-mail. Entre ou recupere sua senha.</div>
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F2F5F9;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #ffffff; box-shadow: 0 10px 18px rgba(16, 84, 178, 0.08); border-radius: 16px; overflow: hidden;">

                    <!-- Header -->
                    <tr>
                        <td style="background: #ffffff; padding: 36px 30px 28px; text-align: center; border-bottom: 1px solid #e2e8f0;">
                            <img src="https://teufit.com.br/img/teufit-lockup.png" alt="TeuFit" width="180" style="display: block; margin: 0 auto; width: 180px; max-width: 60%; height: auto; border: 0; color: #1054B2; font-size: 24px; font-weight: 800; letter-spacing: 0.03em; font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 44px 40px;">
                            <h2 style="margin: 0 0 12px; color: #0F1B2D; font-size: 22px; font-weight: 800; text-align: center;">
                                Você já tem uma conta
                            </h2>

                            <p style="margin: 0 0 16px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Recebemos um pedido de cadastro no TeuFit com este e-mail, mas ele já está ligado a uma conta.
                            </p>

                            <p style="margin: 0 0 28px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Entre no app com seu e-mail e senha, ou com Google/Apple se foi assim que você se cadastrou. Esqueceu a senha? Toque em <strong>Esqueci minha senha</strong> na tela de entrada.
                            </p>

                            <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.7; text-align: center;">
                                Se não foi você, pode ignorar este e-mail. Sua conta não foi alterada.
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f7fafc; padding: 24px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                © 2026 TeuFit. Todos os direitos reservados.
                            </p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `;

        // In test mode with no client configured, act as a no-op
        if (!this.resendClient) {
            return Promise.resolve();
        }

        return this.resendClient.emails.send({
            from: 'noreply@teufit.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }
}

export default new EmailHandler();
