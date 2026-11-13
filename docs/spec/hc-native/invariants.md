# Invariantes de piher como herramienta de orquestación (E1–E12)

Una regla decide qué pertenece a piher y qué no: **piher es dueña de la contabilidad; el modelo,
del juicio.** Todo lo que sigue se puede afirmar o negar con una medición, y ninguno de los doce
exige que el modelo sea listo.

Convención del repo: un test **saltado** en `packages/ext/test/open-invariants.test.ts` es un
invariante **abierto**, con su evidencia y lo que debe pasar para cerrarse. Cuando se cierra, el
test se muda al fichero que posee ese comportamiento y este documento cambia de estado.

| # | invariante | estado | qué lo mide |
|---|---|---|---|
| E1 | todo settlement se anuncia, exactamente una vez, con su identidad | **abierto** | durabilidad cerrada en `0062166` (ledger + cursor, probado a través de un reinicio); la **entrega** sigue en 3 de 10: `test/settlement-transport.test.ts` |
| E2 | un worker que hizo su trabajo nunca se reporta como fallo | **cerrado** | `test/integration/subagent-spawn.test.ts`: un hijo que contesta y sale settlea con su informe; el fallo de arranque solo queda cuando no hay documento |
| E3 | el estado que ves es el del core, nunca una conjetura | **cerrado** | settle = `turn` + documento; `test/subagent-poller.test.ts` |
| E4 | el informe íntegro es alcanzable sin el pane | **cerrado** | `test/subagent-session.test.ts`; probado en vivo tras `/reload` (L9) |
| E5 | un informe perdido es recuperable sin adivinar | **abierto** | G10 residual: si el registro se barrió, no hay camino |
| E6 | el coste por evento en el master está acotado | **abierto** | cap de 16 KB por aviso existe; no hay presupuesto de sesión |
| E7 | el master no necesita preguntar para enterarse | **cerrado** | `triggerTurn` en cada settlement; `test/index-parts.test.ts` |
| E8 | el estado de piher sobrevive a la compactación del master | **abierto** | el buffer no se pausa; el roster no se re-inyecta |
| E9 | una ráfaga de N spawns no produce falsos fallos | **cerrado** | `test/integration/subagent-spawn.test.ts`: diez spawns en una tanda, diez settlements, cero fallos de arranque |
| E10 | el coste por worker no crece con N en el core | **abierto** | una suscripción `events.subscribe` sin filtro por worker |
| E11 | el roster refleja la realidad, incluido un pane matado por fuera | **abierto** | un pane muerto por fuera no es un settle |
| E12 | el master nunca re-hace trabajo ya hecho | **cerrado** | `test/integration/subagent-spawn.test.ts`: el aviso de un hijo que settleó no invita a relanzar; uno que nunca arrancó sí |

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
