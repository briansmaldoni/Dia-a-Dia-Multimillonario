# Reglas del proyecto — Día a Día Multimillonarios

## 1. Publicación automática a GitHub en cada cambio
- Este repositorio está vinculado a `https://github.com/briansmaldoni/Dia-a-Dia-Multimillonario` (rama `main`), desde donde se sirve la PWA / TWA en GitHub Pages.
- **Regla obligatoria:** cada vez que se editen y verifiquen cambios en este proyecto, siempre hacer `git add`, `git commit` (con un mensaje claro en español) y `git push origin main` antes de dar por terminada la tarea, para que el usuario pueda probar la nueva versión al instante desde la app.

## 2. Caché del Service Worker (`sw.js`)
- Siempre que se modifiquen archivos de frontend (`index.html`, `styles.css`, `app.js`, `manifest.json`, etc.), incrementar la versión de `CACHE_NAME` en `sw.js` (por ejemplo, `multimillonarios-cache-v47`) antes de hacer commit y push para forzar la actualización de caché en ambos teléfonos.

## 3. Backend en Google Apps Script (`Code.gs` y `appsscript.json`)
- **Script ID:** `1A-sYaFTCq8TpCqKnRz7e76rE106AvvnHFYJA5QoTCJqVM0R5sINPVcvd`
- **Deployment ID activo fijo:** `AKfycbwHJx8AhDKR5k1eZSQ74hleTxUSy_0I_u83aOOvxIOK1IqtF_e87joQdpmDw70wSF7w` *(corresponde a la URL `/exec` configurada en `app.js`)*.
- **Regla obligatoria:** siempre que se edite cualquier archivo `.gs` (como `Code.gs`) o `appsscript.json`, después de verificar los cambios:
  1. Ejecutar `clasp push` para subir los archivos de Apps Script configurados por `.clasp.json` y `.claspignore`.
  2. Ejecutar `clasp deploy -i AKfycbwHJx8AhDKR5k1eZSQ74hleTxUSy_0I_u83aOOvxIOK1IqtF_e87joQdpmDw70wSF7w -d "<breve descripción>"` para publicar una nueva versión sobre el deployment fijo sin cambiar la URL `/exec`.
  3. Hacer `git add`, `git commit` y `git push origin main` a GitHub.

## 4. Seguridad y archivos locales
- Nunca subir credenciales privadas, tokens ni claves secretas (por ejemplo `.clasprc.json`, `.env`, `greenApiToken_*` o `greenApiId_*`) a archivos del repositorio ni a `app.js`/`index.html`. Todas las credenciales de la app van únicamente en la pestaña `Config` del Google Sheet.
- Mantener la carpeta local `.agents/` fuera del control de versiones (listada en `.gitignore`).
