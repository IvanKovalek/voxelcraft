# Servidor público de VOXELCRAFT

Este servidor **solo se encarga de la conexión** entre jugadores:

- **Encuentro de jugadores:** los que entran a la misma sala se encuentran y se conectan directo entre navegadores (WebRTC).
- **Relevo:** si la red de alguien no deja la conexión directa (wifi del colegio o del trabajo, datos móviles con NAT estricto), los datos del juego pasan por este servidor. Así juega igual.
- **Datos desde el worker:** cada 5 minutos baja su configuración y su plugin del **worker de Cloudflare** (`/srv/config` y `/srv/plugin.js`). Por eso, actualizando solo el worker, el servidor se actualiza solo. **No hace falta volver a tocar GitHub ni Render.**

No tiene dependencias: solo Node.js.

---

## 1. Subir a GitHub

1. Entrá a <https://github.com/new> y creá un repositorio, por ejemplo `voxelcraft-server`. Puede ser público o privado.
2. En el repositorio vacío tocá **"uploading an existing file"** y arrastrá estos archivos:
   - `server.js`
   - `package.json`
   - `render.yaml`
   - `README.md`
3. Tocá **Commit changes**.

## 2. Montarlo en Render

1. Entrá a <https://render.com> e iniciá sesión con tu cuenta de GitHub.
2. Tocá **New + → Web Service** y elegí el repositorio `voxelcraft-server`.
3. Completá:
   - **Runtime:** Node
   - **Build Command:** `echo ok` (no instala nada)
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. En **Environment Variables** agregá:
   - `WORKER_URL` = la dirección de tu worker, por ejemplo `https://voxelcraft.tuusuario.workers.dev`. Va sin barra al final.
   - `SERVER_KEY` = tu clave secreta (mirá la sección 3b).
5. Tocá **Create Web Service** y esperá que diga **Live**.
6. Copiá la dirección que te da Render, por ejemplo `https://voxelcraft-server.onrender.com`.

Abrí esa dirección en el navegador: tiene que decir **"🟢 Servidor de VOXELCRAFT funcionando"** y **"✅ cargado"** al lado del worker.

## 3. Decirle al worker dónde está el servidor

En Cloudflare → Workers → tu worker → **Settings → Variables and Secrets** agregá:

| Nombre | Valor |
|---|---|
| `GAME_SERVER` | `wss://voxelcraft-server.onrender.com` (la de Render, cambiando `https` por `wss`) |
| `SERVER_MOTD` | *(opcional)* un mensaje de bienvenida que ven todos al conectarse |

Guardá y listo: el juego ya usa el servidor. En el panel **Multijugador** (tecla J) vas a ver `servidor ✅`.

## 3b. El mundo 24/7 (servidor público con cuenta)

El servidor también tiene un **mundo que existe siempre**, aunque no haya nadie conectado. En el menú del juego aparece el botón **🌐 Servidor 24/7**. Solo entran jugadores con cuenta.

El servidor guarda:
- los bloques;
- los cofres;
- la hora del día;
- la posición, la vida y el inventario de cada cuenta.

Todo queda en la base **D1** del worker, así que no se pierde aunque Render se reinicie. Para que pueda guardar, inventá una clave secreta larga (por ejemplo `vxc-8f3k2-pt9q-zz71`) y ponela **igual en los dos lados**:

| Dónde | Variable | Valor |
|---|---|---|
| Render → Environment | `SERVER_KEY` | tu clave secreta |
| Cloudflare → worker → Variables (como *Secret*) | `SERVER_KEY` | la misma clave |
| Cloudflare → worker → Variables *(opcional)* | `SERVER_ADMINS` | usuarios administradores separados por coma, ej: `ivkvk,amigo2` |

- **Reglas del mundo 24/7:** se juega en supervivencia con dificultad Normal (se cambia en `pubDiff` dentro del worker).
- **Administradores:** son los de `SERVER_ADMINS`. Pueden usar el modo creativo.
- **Si falta `SERVER_KEY`:** el mundo funciona igual, pero se borra cuando Render se reinicia. El juego avisa con un mensaje.

## 4. Mantenerlo prendido 24/7 con UptimeRobot

El plan gratis de Render apaga el servidor después de 15 minutos sin visitas. Para que no se duerma:

1. Entrá a <https://uptimerobot.com> y creá una cuenta gratis.
2. Tocá **+ New monitor** y completá:
   - **Monitor Type:** HTTP(s)
   - **URL:** `https://voxelcraft-server.onrender.com/health`
   - **Monitoring Interval:** 5 minutes
3. Guardá.

Render da 750 horas gratis por mes, que alcanzan justo para un servidor prendido todo el mes.

---

## Cómo se actualiza

| Qué cambiás | Qué tenés que hacer |
|---|---|
| El juego (el worker) | Solo subís el `worker.js` nuevo a Cloudflare. El servidor baja los datos nuevos solo, en 5 minutos como mucho. |
| Querés que tome los cambios ya | Abrí `https://voxelcraft-server.onrender.com/reload` |
| Este archivo `server.js` | Casi nunca hace falta. Si alguna vez cambia, lo subís a GitHub y Render lo redespliega solo. |

## Direcciones útiles del servidor

- `/`: estado (jugadores, salas, versión de los datos del worker)
- `/health`: responde `ok` (es la que usa UptimeRobot)
- `/stats`: lo mismo en JSON
- `/reload`: vuelve a bajar la configuración del worker

## Privacidad

El servidor no ve el nombre de las salas: solo un código derivado (hash). Las ofertas de conexión van cifradas. Lo que pasa por el relevo son los mensajes del juego entre los jugadores de esa sala; no se guarda nada.
