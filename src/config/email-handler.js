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

    sendWaitlistConfirmationEmail({to}) {
        const subject = '[TreinoWay] Que bom ter você conosco! 🎉';
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bem-vindo ao TreinoWay</title>
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
                                TREINOWAY
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
                                Em breve, você terá acesso exclusivo a todas as funcionalidades do TreinoWay!
                            </p>
                            
                            <!-- Features Box -->
                            <table role="presentation" style="width: 100%; margin: 0 0 30px; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 0;">
                                        <!-- For Students -->
                                        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; background-color: #1e6fdb; border-radius: 12px;">
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
                                        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; background-color: #ff9a56; border-radius: 12px;">
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
                                <strong style="color: #4b5563;">Equipe TreinoWay</strong>
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
                                © 2026 TreinoWay. Todos os direitos reservados.
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
            from: 'onboarding@contato.treinoway.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }

    sendStudentLinkedEmail({to, trainerName}) {
        const teamLabel = trainerName ? `time de ${trainerName}` : 'time do seu treinador';
        const subject = '[Teufit] Bem-vindo ao teste fechado! 🚀';
        const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Você foi vinculado a um time</title>
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
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 50px 40px;">
                            <!-- Beta badge -->
                            <table role="presentation" style="width: 100%; margin: 0 0 20px; border-collapse: collapse;">
                                <tr>
                                    <td align="center">
                                        <span style="display: inline-block; background-color: #dbeafe; color: #1e40af; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 6px 14px; border-radius: 999px;">
                                            🚀 Acesso antecipado • Teste fechado
                                        </span>
                                    </td>
                                </tr>
                            </table>

                            <h2 style="margin: 0 0 20px; color: #020617; font-size: 24px; font-weight: 700; text-align: center;">
                                Você está no teste fechado do Teufit!
                            </h2>

                            <p style="margin: 0 0 16px; color: #4b5563; font-size: 16px; line-height: 1.7; text-align: center;">
                                Você foi vinculado ao ${teamLabel} e é uma das primeiras pessoas a usar o Teufit. Estamos muito felizes em ter você nessa fase inicial com a gente.
                            </p>

                            <!-- What to expect -->
                            <table role="presentation" style="width: 100%; margin: 24px 0; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 0;">
                                        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: separate; background-color: #1e6fdb; border-radius: 12px;">
                                            <tr>
                                                <td style="padding: 24px;">
                                                    <p style="margin: 0 0 14px; color: #ffffff; font-size: 17px; font-weight: 700;">
                                                        O que esperar desta fase
                                                    </p>
                                                    <p style="margin: 0; color: #ffffff; font-size: 14px; line-height: 1.8; font-weight: 600; opacity: 0.95;">
                                                        🐛 Alguns bugs podem aparecer — é esperado e faz parte do processo.<br>
                                                        💬 Seu feedback molda o produto: conte o que funciona e o que pode melhorar.<br>
                                                        🤝 Sua participação é muito importante para deixar o Teufit cada vez melhor.
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

                            <p style="margin: 30px 0 0; color: #6b7280; font-size: 15px; line-height: 1.6; text-align: center;">
                                Bons treinos,<br>
                                <strong style="color: #4b5563;">Equipe Teufit</strong>
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f7fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                © 2026 Teufit. Todos os direitos reservados.
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
            from: 'onboarding@contato.treinoway.com.br',
            to,
            html: htmlContent,
            subject: subject,
        });
    }
}

export default new EmailHandler();