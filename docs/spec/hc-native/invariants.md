# Invariantes de piher como herramienta de orquestación (E1–E13)

Una regla decide qué pertenece a piher y qué no: **piher es dueña de la contabilidad; el modelo,
del juicio.** Todo lo que sigue se puede afirmar o negar con una medición, y ninguno de los doce
exige que el modelo sea listo.

Convención del repo: un test **saltado** en `packages/ext/test/open-invariants.test.ts` es un
invariante **abierto**, con su evidencia y lo que debe pasar para cerrarse. Cuando se cierra, el
test se muda al fichero que posee ese comportamiento y este documento cambia de estado.

| # | invariante | estado | qué lo mide |
|---|---|---|---|
| E1 | todo settlement se anuncia, exactamente una vez, con su identidad | **cerrado** | durabilidad `0062166`; entrega `39c63e1` (10 de 10 en 4.090 B, medido) y `test/settlement-transport.test.ts`; recuperación `test/subagent-inbox.test.ts`: `inbox` devuelve los hechos tras `since` con su `seq`, y un segundo call no repite |
| E2 | un worker que hizo su trabajo nunca se reporta como fallo | **cerrado** | `test/integration/subagent-spawn.test.ts`: un hijo que contesta y sale settlea con su informe; el fallo de arranque solo queda cuando no hay documento |
| E3 | el estado que ves es el del core, nunca una conjetura | **cerrado** | settle = `turn` + documento; `test/subagent-poller.test.ts` |
| E4 | el informe íntegro es alcanzable sin el pane | **cerrado** | `test/subagent-session.test.ts`; probado en vivo tras `/reload` (L9) |
| E5 | un informe perdido es recuperable sin adivinar | **cerrado** | `test/subagent-inbox.test.ts`: un registro barrido sigue dando su hecho y su cuerpo desde `piher.rep.<pane>`; si el documento falta o es de otra tarea, la fila dice qué se estableció |
| E6 | el coste por evento en el master está acotado | **cerrado** | `test/session-budget.test.ts`: el techo de sesión (32 KiB, `PIHER_SESSION_REPORT_BUDGET_BYTES`) se suma al de 4 KB por entrega — bajo el techo nada cambia, encima los cuerpos son punteros y la entrega lo dice con sus números; el contador es durable (`<ledger>.bytes`), así que un reinicio no regala techo |
| E7 | el master no necesita preguntar para enterarse | **cerrado** | `triggerTurn` en cada settlement; `test/index-parts.test.ts` |
| E8 | el estado de piher sobrevive a la compactación del master | **cerrado** | `test/compaction.test.ts`: el buffer se pausa entre `session_before_compact` y `session_compact`/`..._failed` y un settlement anunciado en la ventana se entrega tras el corte, nunca dentro del prefijo; y el roster se re-inyecta desde los registros (en vivo / settled-unread / fallido), acotado a 1.200 B con treinta tareas |
| E9 | una ráfaga de N spawns no produce falsos fallos | **cerrado** | `test/integration/subagent-spawn.test.ts`: diez spawns en una tanda, diez settlements, cero fallos de arranque |
| E10 | el coste por worker no crece con N en el core | **abierto** | una suscripción `events.subscribe` sin filtro por worker |
| E11 | el roster refleja la realidad, incluido un pane matado por fuera | **cerrado** | `test/subagent-poller.test.ts`: un pane matado por fuera (o barrido: el core ya no lo lista) llega como **un** hecho `pane-gone` con la razón del core (`killed`, el código de salida, o un cierre sin palabra), la identidad (pane, tarea, descripción, duración) y la llamada `output` que lee lo que dejó; se anuncia al **observarlo**, sin esperar al presupuesto de silencio, y un aviso rechazado se reintenta con la misma `(taskId, at)`. Un settle seguido de la muerte del pane entrega solo el settle; un pane que nunca arrancó sigue siendo el fallo de spawn (`test/integration/subagent-spawn.test.ts`) |
| E12 | el master nunca re-hace trabajo ya hecho | **cerrado** | `test/integration/subagent-spawn.test.ts`: el aviso de un hijo que settleó no invita a relanzar; uno que nunca arrancó sí |
| E13 | un hijo que ya está trabajando es ready, y el aviso no puede negarlo | **cerrado** (`a33b116`) | nacido en vivo en L14: 86 s de espera y "did not take its first message" sobre un pane que estaba trabajando |

## Por qué estos y no otros

- **E1, E2, E11, E12** son el mismo tipo de defecto: un hecho del mundo que no llega íntegro o
  llega torcido. Un instrumento de contabilidad que miente sobre quién terminó no es un
  instrumento, por muy bien que transporte.
- **E5, E6, E8** son los límites de recuperación y de coste: el informe tiene que seguir siendo
  alcanzable cuando el pane, el registro y la conversación ya no lo están.
- **E3, E4, E7** están cerrados y hay que mantenerlos cerrados: son la razón por la que el refactor
  hc-native valió la pena.
- **E9, E10** son de escala: aparecen con N, no con la lógica.

## Fuera de piher, por definición

- **El juicio a 40**: leer 40 filas y decidir bien. Ningún invariante lo arregla; es lo que el
  dueño del proyecto deja explícitamente al modelo.
- **La física**: 40 × ~190 MB de RSS + 40 PTYs + 40 worktrees. piher solo puede hacer que el límite
  sea visible — decirlo — en vez de silencioso.
