# Explorador de esquemas SAS

UI para inspeccionar las tablas SAS y las interrelaciones entre campos de los
pipelines del repositorio [`alektebel/regllm`](https://github.com/alektebel/regllm),
extraídas con el propio compilador SAS del proyecto (`src/sas_logic_tree.py`).

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
