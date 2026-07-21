# Explorador de esquemas SAS

## La aplicación: Angular + backend FastAPI

Aplicación donde cargas **tus propios** programas `.sas` o proyectos de
Enterprise Guide `.egp` (también puedes pegar código) y explora:

- todas las tablas (pasos DATA, MERGE, PROC SQL, DATALINES) con su rol,
  filtros, claves BY y campos — marcando cuáles se crean en cada paso y con
  qué fórmula;
- el grafo de flujo entre tablas;
- el linaje campo a campo (ancestros y descendientes, con las expresiones de
  cada relación);
- descarga del inventario completo en texto plano.

### Backend (`backend/`) — el compilador real de regllm

El backend FastAPI importa directamente `src/sas_logic_tree.py` del
repositorio [`alektebel/regllm`](https://github.com/alektebel/regllm), con
expansión de macros (`%MACRO`/`%LET`), y descomprime los `.egp` (archivos ZIP
con los programas embebidos) en el servidor. También sirve el frontend
compilado, así que un solo proceso lo ejecuta todo:

```bash
# requisitos: un clon de alektebel/regllm
pip install -r backend/requirements.txt
cd sas-schema-explorer && npm install && npx ng build && cd ..
REGLLM_PATH=/ruta/a/regllm uvicorn backend.main:app --port 8000
# → abre http://localhost:8000
```

API: `POST /api/analyze` (multipart: `files` = .sas/.egp, `pasted` = código) →
JSON con tablas, campos y linaje. `GET /api/health` para comprobar el estado.

#### Descripciones de flujo con un modelo GGUF (opcional)

El compilador siempre calcula el grafo, las tablas finales y sus entradas de
forma determinista. Para añadir una frase corta en español a cada tabla del
flujo final, instala la dependencia opcional y configura un modelo local:

```bash
pip install -r backend/requirements-gguf.txt
export GGUF_MODEL_PATH=/ruta/al/modelo-instruct.gguf
export GGUF_N_CTX=4096       # opcional
export GGUF_THREADS=4        # opcional
REGLLM_PATH=/ruta/a/regllm uvicorn backend.main:app --port 8000
```

El modelo se carga bajo demanda con `llama-cpp-python` y solo recibe los
nombres de tablas, entradas, operaciones y campos necesarios para describir el
flujo; el código SAS no se envía a ningún servicio externo. La salida del
modelo se valida para impedir tablas inventadas o faltantes. Si no se define
`GGUF_MODEL_PATH`, el modelo no está instalado o devuelve JSON inválido, la
aplicación conserva el grafo determinista y genera descripciones de respaldo.
En el flujo se muestran las tablas como `tabla [entradas] (descripción)` y la
tabla final identificada.

### Frontend (`sas-schema-explorer/`, Angular 19)

```bash
cd sas-schema-explorer
npm install
npm start               # ng serve con proxy /api → localhost:8000
npm run build:single    # único HTML autocontenido (solo análisis local)
```

El frontend llama primero al backend (chip «⚙ compilador regllm»); si no está
disponible, usa un port TypeScript aproximado del subconjunto de extracción
(`src/app/sas/`, chip «≈ análisis local», sin expansión de macros). En ambos
casos el código SAS no sale de tu equipo.

## Versión estática original (raíz del repo)

La primera versión inspeccionaba los pipelines de regllm con datos
pre-extraídos usando directamente el compilador Python.

## Qué hace

- **Inventario de tablas**: las 23 tablas de los 3 pipelines SAS del repo
  (sesión `debug_lgd`, calibración LGD de muestra y el pipeline DQC
  `ciclos_calibrados` de 7 capas), con su rol (fuente externa, semilla
  DATALINES, derivada o final), fichero de origen, filtros WHERE, claves BY
  y campos — marcando cuáles se crean en cada paso y con qué fórmula.
- **Flujo de tablas**: grafo de dependencias entre tablas (SET / MERGE /
  PROC SQL).
- **Linaje de campos**: para cualquier campo, grafo por capas de todos sus
  ancestros (¿de dónde viene?) o descendientes (¿a qué afecta?), con las
  expresiones de cada arista; las influencias por condición (IF/WHERE) se
  dibujan con línea discontinua.
- **Descarga en texto**: botón «Descargar .txt» que genera el inventario
  completo en texto plano (también incluido aquí como
  `tablas_sas_regllm.txt`).

## Ficheros

| Fichero | Descripción |
|---|---|
| `index.html` | UI autocontenida (abrir directamente en el navegador) |
| `extract_schema.py` | Extrae `schema.json` usando el compilador de regllm |
| `index.template.html` | Plantilla de la UI (sin datos) |
| `build_ui.py` | Inyecta `schema.json` en la plantilla → `index.html` |
| `schema.json` | Tablas, campos y aristas de linaje extraídos |
| `tablas_sas_regllm.txt` | Inventario completo en texto plano |

## Regenerar

```bash
# Requiere un clon de alektebel/regllm
python extract_schema.py --regllm /ruta/a/regllm --out schema.json
python build_ui.py
```
