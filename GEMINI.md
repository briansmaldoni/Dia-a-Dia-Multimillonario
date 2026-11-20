# Reglas del proyecto — Día a Día Multimillonarios

## 1. Publicación automática a GitHub en cada cambio
- Este repositorio está vinculado a `https://github.com/briansmaldoni/Dia-a-Dia-Multimillonario` (rama `main`), desde donde se sirve la PWA / TWA en GitHub Pages.
- **Regla obligatoria:** cada vez que se editen y verifiquen cambios en este proyecto, siempre hacer `git add`, `git commit` (con un mensaje claro en español) y `git push origin main` antes de dar por terminada la tarea, para que el usuario pueda probar la nueva versión al instante desde la app.

## 2. Caché del Service Worker (`sw.js`)
- Siempre que se modifiquen archivos de frontend (`index.html`, `styles.css`, `app.js`, `manifest.json`, etc.), incrementar la versión de `CACHE_NAME` en `sw.js` (por ejemplo, `multimillonarios-cache-v47`) antes de hacer commit y push para forzar la actualización de caché en ambos teléfonos.

## 3. Backend en Google Apps Script (`Code.gs`)
- Si la tarea incluye modificaciones en `Code.gs`, recordarle explícitamente al usuario al finalizar que debe copiar/pegar el `Code.gs` actualizado en el editor de Google Apps Script y publicar una **Nueva versión** desde **Implementar → Administrar implementaciones**.

## 4. Seguridad y archivos locales
- Nunca subir credenciales privadas, tokens ni claves secretas (por ejemplo `greenApiToken_*` o `greenApiId_*`) a archivos del repositorio ni a `app.js`/`index.html`. Todas las credenciales van únicamente en la pestaña `Config` del Google Sheet.
- Mantener la carpeta local `.agents/` fuera del control de versiones (listada en `.gitignore`).
