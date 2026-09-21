# Vantage City OS

A holographic, live-data 3D map of London built only on free and open APIs.

## Run it

```bash
node server.mjs
```

Then open http://localhost:8765. Node 18+ is required and nothing needs installing: the libraries load from jsDelivr.

The page opens on a welcome screen. The city loads and circles behind it, and a live system check shows each feed coming online. Press **Enter** (or the button) to fly in. Add `?enter` to the URL to skip straight to the map while developing.

### Sound

The soundscape is synthesised live with Web Audio. There are no recordings, so nothing to download or license. It's spatial and follows the scene: traffic sits on the major roads in view, trains run along the rail lines on screen, jet noise follows the live aircraft, wind follows the live weather, and a crowd murmur rises at street level. Sound is on by default and starts with your first click (normally Enter), since browsers hold audio back until then. Mute with the speaker button (top right) or `A`.

## Ordnance Survey (optional, recommended)

Without a key, the map already shows British National Grid references (in the telemetry, in building scans, and as a search input such as `TQ 3004 7963`). With a free OS Data Hub key, it also:

- builds the holographic city from **OS MasterMap Topography Layer** buildings (OS Vector Tile API, zoom 16, `RelHMax` heights) inside a zone around the view centre, marked by a violet ring on the survey grid, with OSM buildings continuing beyond it;
- lets you **click a building** to query **OS NGD Buildings**: use, construction age and material, floors, measured heights, roof shape and material, solar panels, green roof and south-facing roof area. **OS Linked Identifiers** adds its TOID, UPRNs (addresses) and USRN (street);
- adds **OS Names** gazetteer results (places, roads, postcodes) to search;
- shows the official OS logo and copyright statement via [os-api-branding](https://github.com/OrdnanceSurvey/os-api-branding).

Setup:

1. Create a free account at [osdatahub.os.uk](https://osdatahub.os.uk). Choose the **Premium** plan for the MasterMap and NGD data; it includes £1,000 of free premium transactions a month. OpenData calls are unlimited on every plan.
2. Create a project and add **OS Vector Tile API**, **OS Names API**, **OS NGD API – Features** and **OS Linked Identifiers API**.
3. Copy `.env.example` to `.env`, paste the project key after `OS_API_KEY=`, and restart `node server.mjs`. The console confirms "OS Data Hub: key loaded".

With an **OpenData-plan** key you get OS Names search, Linked Identifiers and **Boundary-Line**. The Sector analysis card then shows the borough, ward (with its ONS code) and Westminster constituency under the view centre, and borough and ward outlines are drawn on the map. At startup the server checks what the key can reach, so layers the plan can't serve never start. The Data feeds panel and event log say exactly what's missing: for example, "A Premium Plan is required to access Premium Data" for MasterMap, or "Add OS NGD API – Features to your Data Hub project".

The key stays on the server: the browser only talks to `/api/os/...`, and `.env` is never served (or committed: it's in `.gitignore`). The server caches OS responses. The **Data feeds** panel shows how many premium tiles and NGD calls have been used since the server started; the Data Hub dashboard has the authoritative figures. Press `M` to switch the OS buildings off and on.

## Deploy (Vercel)

The repo deploys to Vercel as it is, with no build step. The static files are served from the CDN, and each proxy route in `api/` becomes a serverless function in London (`lhr1`) that shares its code with the local server (`lib/api.mjs`). Successful proxy answers carry `s-maxage` headers, so the CDN absorbs repeat requests and the OS allowance goes further.

1. Import the GitHub repo into Vercel (framework preset **Other**, no build command).
2. Under **Project Settings → Environment Variables**, add `OS_API_KEY` with your OS Data Hub project key.
3. Redeploy. Environment variables only reach a deployment built after they were added.

Without the key, the site still runs on OpenStreetMap buildings; the OS layers report that the key is missing.

## Controls

| Key | Action |
| --- | --- |
| `1`–`0` | Toggle layers (city, green space, air, routing, rail, cycles, roads, aircraft, wind, grid) |
| `I` / `B` / `O` / `P` | Satellite imagery · bloom · cinematic orbit · world panels |
| `M` | OS MasterMap buildings on/off (needs the OS Premium plan) |
| `A` | Sound on/off |
| Panel `×` | Close a floating panel (it stays closed until its subject changes; `P` twice brings everything back) |
| Panel backing | Slider in the Layers card sets how dark the floating panels are |
| `R` | Plan a route (click origin, then destination) |
| Right-click | Route from the current origin to that point (Shift + right-click sets the origin) |
| Click | Scan a building, a cycle dock or a road disruption |
| `/` | Search any place worldwide, or type a grid reference (`TQ 30 80`) or eastings, northings |
| `Space` | Fire a radar pulse |
| `H` | Hide the HUD |

## How it works

- **MapLibre GL** draws a dark base map from OpenFreeMap vector tiles. It includes near-black 3D building bodies that hide streets behind them.
- **three.js** draws everything that glows on a second canvas. It is driven by MapLibre's own camera matrix every frame (a custom layer captures it), rendered through bloom, and composited as light (alpha is derived from brightness).
- **Holographic buildings** are built from the same vector tiles by a small decoder (`js/city-core.js`) running in web workers. It clips tiles, extrudes walls, triangulates roofs and quantises positions to Int16 to keep GPU memory low. Shaders draw edges, floor lines, window flicker and radar pulses analytically.
- **World-anchored panels** are real DOM elements warped onto rectangles in 3D space with a CSS `matrix3d` homography. That keeps the text crisp while the panels tilt with the camera.
- **Land statistics** (built, green and water cover; heights; floor area) are rasterised per tile in the workers. Park pieces split across tile edges are joined back together so each park's area is complete.
- **Routing optimisation** scores OSRM alternatives on travel time, modelled air-quality exposure along the path (CAMS grid) and live TfL road disruptions.

## Data sources

| Feed | Source | Key? |
| --- | --- | --- |
| Vector tiles, buildings, land cover | OpenFreeMap / OpenMapTiles / © OpenStreetMap | No |
| Air quality (EAQI, PM2.5, NO₂, O₃) | Open-Meteo Air Quality (CAMS Europe) | No |
| Weather | Open-Meteo Forecast | No |
| Tube, Elizabeth line, DLR, line status, road disruptions, Santander Cycles | TfL Unified API | No (optional key for higher limits) |
| Routing | OSRM via FOSSGIS (routing.openstreetmap.de) | No |
| Aircraft | adsb.lol, fallback adsb.fi (via the server proxy) | No |
| Place search | Nominatim (via the server proxy) | No |
| Optional imagery | Esri World Imagery | No; check Esri's terms for production use |
| MasterMap buildings | OS Vector Tile API | OS key (Premium data, free allowance) |
| Building attributes | OS NGD API – Features (Building, Building Part) | OS key (Premium data, free allowance) |
| TOID → UPRN → USRN | OS Linked Identifiers API | OS key (OpenData) |
| UK gazetteer search | OS Names API | OS key (OpenData) |
| Borough, ward, constituency | OS Vector Tile API · Boundaries overlay (Boundary-Line) | OS key (OpenData) |
| Grid references | Computed locally (`js/bng.js`) | No |

`lib/api.mjs` proxies the APIs that block browser requests (ADS-B, which sends no CORS headers, and Nominatim, which needs a real User-Agent), plus every Ordnance Survey call (`os-proxy.mjs`), so the OS key is never exposed. It caches responses to stay inside fair-use limits. Locally, `server.mjs` serves the app and calls it; on Vercel, the functions in `api/` do.

Grid conversions use the 7-parameter Helmert transform and the National Grid Transverse Mercator projection from OS's *A Guide to Coordinate Systems in Great Britain*. The projection matches OS's worked example to the millimetre. The WGS84 ↔ OSGB36 datum shift is good to about ±5 m; OSTN15 would be needed for survey-grade accuracy.
