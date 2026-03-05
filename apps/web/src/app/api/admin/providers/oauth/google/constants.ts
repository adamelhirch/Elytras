// Redirect URI partagé entre start et exchange.
// Identique à celui du CLI Gemini — l'user n'a pas besoin que localhost:8085
// tourne, il colle juste l'URL de callback manuellement.
export const GOOGLE_REDIRECT_URI = "http://localhost:8085/oauth2callback";
