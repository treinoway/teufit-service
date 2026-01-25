# Documento de Especificação: Ajuste na Autenticação Google para Mobile

## 1. Diagnóstico Atual
Analisei a especificação OpenAPI (`gaujofit_service`) e identifiquei que os endpoints atuais de autenticação social foram projetados utilizando o fluxo **OAuth2 Authorization Code para Web**.

**Endpoints Existentes:**
1.  **`GET /auth/google/start`**: Redireciona o navegador do usuário para o Google (`302 Redirect`).
2.  **`GET /auth/google/callback`**: Recebe o `code` do Google via query param e faz um novo redirecionamento (`302 Redirect`) para o frontend web.

## 2. Por que isso não funciona no Flutter?

### A. Incompatibilidade de UX e Segurança (Google Policy)
O Google bloqueia tentativas de login feitas dentro de WebViews simples por razões de segurança. Para usar os endpoints atuais, o App teria que abrir o navegador do sistema (Chrome/Safari), fazer o usuário logar, e depois tentar interceptar um "Deep Link" no redirecionamento final. Isso gera uma experiência de usuário pobre e propensa a falhas.

### B. Gestão de Sessão (Cookies vs Tokens)
O fluxo atual termina com um redirecionamento (`302`) que geralmente anexa um Cookie de sessão ou tenta passar o token na URL para um frontend web.
No mobile, nós utilizamos o **SDK Nativo (`google_sign_in`)**. Este SDK realiza a autenticação internamente no dispositivo e nos entrega um `idToken` (prova de identidade assinada pelo Google).

Nós **não precisamos** que o backend inicie o login (`/start`), nós precisamos que o backend apenas **valide** o login que o App já realizou.

## 3. Solicitação de Ajuste (Novo Endpoint)

Para viabilizar a integração Mobile, precisamos abandonar o fluxo de redirecionamento e adotar o fluxo de **Troca de Token (Token Exchange)**.

### O que precisa ser feito:
Precisamos de um novo endpoint `POST` que aceite um JSON contendo o token gerado pelo Google no celular.

#### Especificação do Novo Endpoint Sugerido

**Rota:** `POST /auth/google/mobile`
**Descrição:** Recebe o `idToken` do Google gerado pelo App, valida a assinatura e retorna a sessão do usuário no sistema.

**Request Body (JSON):**
```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6I..."
}
```

**Response 200 OK (Sucesso):**
Deve retornar a mesma estrutura que já existe no endpoint `/auth/login` (email/senha):

```json
{
  "user": {
    "id": "uuid-do-usuario",
    "email": "usuario@gmail.com",
    "name": "Nome do Google"
  },
  "token": {
    "accessToken": "jwt-da-sua-api"
  },
  "refreshToken": "refresh-token-da-sua-api"
}
```

## 4. Lógica do Backend para este Endpoint

O Backend não deve mais trocar `code` por token junto ao Google (flow web). A lógica muda para:

1.  Receber o `idToken` via POST.
2.  Verificar a validade/assinatura desse token usando as chaves públicas do Google (bibliotecas de Auth Google já fazem isso).
3.  Extrair o email e o ID do Google (sub) do token decodificado.
4.  Verificar se o usuário já existe no banco de dados:
    * **Se sim:** Gera o JWT da sua API e retorna.
    * **Se não:** Cria o usuário automaticamente (Signup silencioso) e retorna o JWT.

## 5. Resumo da Mudança

| Recurso | Implementação Atual (Web) | Implementação Necessária (Mobile) |
| :--- | :--- | :--- |
| **Método HTTP** | `GET` (com Redirects 302) | `POST` (JSON puro) |
| **Input** | `code` via Query Param | `idToken` via Body JSON |
| **Quem inicia** | O Backend redireciona o User | O App inicia nativamente |
| **Resultado** | Redirect para URL do Frontend | JSON com `accessToken` da API |

---
**Ação Recomendada:** Criar o endpoint `POST /auth/google/mobile` conforme especificação acima para desbloquear o desenvolvimento do App Flutter.