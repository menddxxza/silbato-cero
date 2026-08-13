# Notas de desarrollo — Silbato Cero

Registro honesto del estado del proyecto: qué está hecho de verdad, qué está
hecho en versión funcional pero ampliable, y qué falta.

## Fases completadas

| Fase | Estado | Dónde vive |
|---|---|---|
| 1. Motor de partido 2D | ✔ | `match/sim.js`, `match/state.js` |
| 2. Movimiento de jugadores y balón | ✔ | `match/sim.js` |
| 3. Movimiento del árbitro | ✔ | `matchEngine._moveReferee` |
| 4. Incidentes | ✔ | `match/incidents.js` |
| 5. Decisiones arbitrales | ✔ | `matchEngine`, `ui/hud.js` |
| 6. Reglas | ✔ | `rules/ruleEngine.js` |
| 7. Tarjetas | ✔ | `ruleEngine.evaluateDisciplinaryAction` |
| 8. Goles / penaltis / fuera de juego | ✔ | `matchEngine`, `incidents` |
| 9. VAR + tecnología de línea de gol | ✔ | `match/var.js` |
| 10. Nota del árbitro | ✔ | `match/rating.js` |
| 11. Carrera | ✔ | `career/career.js` |
| 12. Clubes y ligas | ✔ | `data/generators.js` |
| 13. Eventos dinámicos | ✔ | `matchEngine._randomIncidents` |
| 14. Prensa | ✔ | `career/press.js` |
| 15. Syndicate | ✔ | `career/syndicate.js` |
| 16. Economía | ✔ (versión simple, a propósito) | `career/career.js` |
| 17. Logros | ✔ | `career/achievements.js` |
| 18. Pulido visual y sonoro | ✔ base sólida, ampliable | `ui/`, `audio/` |

## Calibración del motor

Medias por partido en Primera División Ibérica (`node test/run.js 60`, árbitro
automático con acierto 72%). Con 60 partidos, no con 8: los sucesos raros
—penaltis, rojas— necesitan muestra o el número que sale es ruido.

El banco simula por defecto una **jornada de liga normal**: 90 minutos, sin
eliminatorias y con la temperatura media de un partido cualquiera, que es lo
que se juega la mayor parte del tiempo. Antes mezclaba prórrogas y derbis con
importancia 95, y eso inflaba goles, tarjetas y penaltis sin que se notara.
`node test/run.js 40 copa` mide el otro extremo.

| Métrica | Silbato Cero | Fútbol real (referencia) |
|---|---|---|
| Goles | 2,42 | 2,7 |
| Faltas | 22,6 | 22–26 |
| Amarillas | 2,9 | 3–5 |
| Rojas | 0,25 | 0,1–0,2 |
| Penaltis | 0,18 | 0,25 |
| Fueras de juego | 2,5 | 3–5 |
| Córners | 10,0 | 9–11 |
| Tiros | 25,9 | 24–28 |

Con 60 partidos, la incertidumbre de estas medias es de ±0,25 en los goles y
±0,10 en las rojas: por debajo de eso, mover una constante es mover ruido.

En copa (`node test/run.js 40 copa`): 2,88 goles · 21,1 faltas · 4,4 amarillas ·
0,40 rojas · 0,30 penaltis. Un partido caliente con prórroga da más de todo,
que es lo que pasa en el fútbol.

Los penaltis incluyen las prórrogas de las eliminatorias, que en este banco son
un tercio de los partidos.

Los atributos de los futbolistas se comprimen por categoría
(`generators.compressLevel`): sin esa compresión, la Liga Regional producía
partidos sin una sola ocasión.

Estos rangos están fijados como prueba automática (`test/engine.test.js`): si
un cambio en el motor los rompe, la batería falla antes de llegar al juego.

## Decisiones tomadas a propósito

No son deudas: son límites elegidos y sostenidos.

- **Idiomas**: se entrega en español e inglés, completos y verificados por las
  pruebas. Añadir francés, italiano, alemán o portugués es copiar un archivo de
  `i18n/` y traducir sus valores; las pruebas avisan de cualquier clave que
  falte, esté vacía o pierda una variable. Traducir a ciegas los ~750 textos a
  cuatro idiomas más habría metido en el juego un castellano disfrazado.
- **Economía**: hay ingresos, gasto fijo y siete inversiones con efecto real,
  pero no un catálogo de compras. El juego sigue siendo un simulador arbitral.
- **Syndicate**: cinco capítulos ramificados. Ampliarlo no toca código: son
  datos en `CHAPTERS`.
- **Personalización visual del árbitro**: se elige uniforme, tono de piel,
  cabello y dorsal; el sprite 2D refleja el uniforme, que es lo que se
  distingue desde la cámara cenital.

## Cerrado en la revisión del motor

- **Bloqueos y rechaces en el área.** Los defensores tapan el disparo con más
  alcance dentro de su área; un bloqueo puede irse por la línea de fondo
  (córner) o quedar como rechace. De ahí salen también las manos dentro del
  área. Cada jugador tiene un tiempo de espera para no bloquear dos veces el
  mismo balón.
- **Remates de cabeza.** Un balón alto que cae en el área lo disputa quien
  mejor juega de cabeza: dentro, remate a puerta; fuera, despeje. Sin esto los
  córners no producían nada.
- **Barrera y colocación en el balón parado.** Las faltas a menos de 32 m
  forman barrera de 2 a 4 jugadores a 9,15 m, con rematadores y marcadores
  dentro del área; los córners llenan el área. El servicio se ejecuta de
  verdad: centro al área o disparo directo por encima de la barrera.
  Con el balón por alto los defensores saltan en lugar de entrar, que era la
  causa de una plaga de penaltis en los córners.
- **Reiteración de faltas.** El motor cuenta las faltas de cada jugador y a
  partir de la tercera la infracción pasa a ser amonestable, aunque ninguna
  por separado lo fuera (`evaluateDisciplinaryAction`, hecho `persistent`).
- **Pérdida de tiempo.** A partir del minuto 60, el equipo que va ganando
  estira las reanudaciones. Si el retraso se hace descarado llega al árbitro
  como situación propia, con advertencia verbal previa: una segunda demora
  del mismo jugador ya es amarilla (`evaluateTimeWasting`).
- **Economía con gastos.** Coste fijo por jornada que sube con la categoría,
  siete inversiones con efecto real (gimnasio, fisio, coche, piso, curso de
  reglamento, equipamiento y analista de vídeo) con su mantenimiento, libro de
  movimientos y aviso del banco al entrar en números rojos.

## Cerrado en la revisión final

- **Córners a valores reales (9,8 por partido).** Los despejes bajo presión
  cerca de la línea se van fuera buscando el banderín, y un disparo bloqueado
  que sale desviado hacia el fondo acaba en córner algo más de la mitad de las
  veces: el portero no llega a todo.
- **Cambios con lectura del partido.** Se sustituye por lesión, por desgaste,
  para proteger a un amonestado que juega al límite, para arriesgar cuando se
  pierde (defensa fuera, delantero dentro) y para cerrar cuando se gana. El
  entrante ocupa el hueco táctico que corresponde a su rol, no el del que sale.
  9,8 cambios por partido, minuto medio 72.
- **Repetición navegable.** El motor guarda la jugada de cada incidente con
  peso (goles, tarjetas, penaltis, VAR, impacto alto) y el informe final las
  ofrece en un reproductor con fotograma a fotograma, cuatro cámaras y línea de
  fuera de juego. Los clips viven en memoria: no engordan el guardado.
- **Mando y táctil.** Mando físico vía Gamepad API (palanca izquierda, gatillo
  o A para esprintar, botones frontales y superiores para las seis opciones de
  decisión, Start pausa, Select cambia cámara) con detección de flanco para que
  un botón sostenido no repita la decisión. En pantallas sin teclado aparece una
  palanca virtual y un botón de sprint.
- **Vertical en el móvil.** En pantallas altas el campo se gira un cuarto de
  vuelta y llena el teléfono, en lugar de quedarse en una franja central. La
  dirección de la palanca y del mando gira con él.
- **Batería de pruebas.** 92 pruebas sin dependencias (`node test/all.js`):
  reglamento, sistemas y motor. Incluye las que evitan las regresiones que más
  caro salieron durante el desarrollo: partidos que no terminan, jugadores
  fuera del campo, posesión que no cuadra, equipaciones indistinguibles,
  guardado que pierde datos, claves de idioma que faltan y medias del partido
  fuera de rango.

## Cerrado en la pasada de animación

- **Cuerpos, no fichas.** Los jugadores dejaron de ser discos: torso con el
  color del equipo, cabeza asomando hacia donde miran y extremidades que se
  alternan con la zancada, a la cadencia de su velocidad real y con fase
  propia por jugador. Botan al correr, se tumban al lesionarse y levantan los
  brazos al protestar o celebrar. Por debajo de 7 px de radio se dibuja el
  cuerpo simple: a ese tamaño el detalle era ruido y costaba lo mismo.
- **Balón con rotación y aplastado** al caer, y banderín de asistente que
  sube y ondea en vez de aparecer de golpe.
- **Efectos de retransmisión**: rótulo de gol, papelillos en la grada del
  equipo que marcó, tinte de tarjeta en el borde de la pantalla, tarjeta
  levantada sobre el infractor, onda de silbato, marcador que rueda y nota
  que se desplaza. Todos sólo con `transform` y `opacity`, y todos se apagan
  con `prefers-reduced-motion` (también los del canvas, vía `renderer.motion`).
- **Partido de fondo en el menú.** Un encuentro real jugándose con árbitro
  automático detrás del menú principal, desenfocado. Se para al salir del
  menú para no gastar batería dibujando lo que no se ve.
- **Rendimiento.** La animación multiplicó el coste por fotograma, así que se
  cachearon en capas el público, el halo de los focos y la viñeta: 82 ms →
  14 ms por fotograma dibujado, por debajo incluso de los 68 ms que costaba
  antes de animar nada (medido en el mismo navegador sin GPU).

## Cerrado en la pasada de acabado

- **Sin conexión de verdad.** El README decía que el juego funciona sin
  conexión y era medio cierto: no hay fuentes ni assets remotos, pero hacía
  falta el servidor. Ahora hay service worker con el casco completo en caché
  (estrategia *stale-while-revalidate*: se abre al instante y la siguiente
  carga trae los cambios), manifiesto e icono, así que se instala en el móvil
  como una aplicación y se juega con la red apagada. Verificado en navegador
  con la red cortada: arranca, entra al menú y juega un partido.
  La lista de ficheros se escribe a mano porque no hay compilación, y una
  prueba la compara con el disco: si se añade un módulo y se olvida meterlo,
  la batería falla en vez de romperse el modo sin conexión en silencio.
- **Accesibilidad.** El documento declara el idioma que se lee de verdad
  (`setLocale` actualiza `<html lang>`), el lienzo lleva una descripción con
  marcador y minuto que se refresca cada minuto, los avisos son `role=status`
  y el panel de decisión se anuncia entero y sin esperar, porque hay un reloj
  corriendo. La palanca táctil y el temporizador van etiquetados, y sus textos
  viven en `i18n/` como todo lo demás.

## Texto que seguía viviendo en el código

Una pasada de auditoría buscando literales con acentos dentro de `src/`
destapó que tres sistemas enteros nunca habían pasado por `i18n/`: los 24
logros, los cinco capítulos del Syndicate con sus quince opciones y los
nombres de los seis uniformes. Además, la previa del partido enseñaba
identificadores crudos (`rain`, `balanced`, `manipulative`) y etiquetas
escritas a mano («Agresividad», «Entrenador», «precisión», «criterio», «Sin
VAR en esta categoría»), y la oferta de soborno se componía en castellano.

En inglés, todo eso se veía en español o en clave. Ahora:

- `ACHIEVEMENTS` pasó a ser `ACHIEVEMENT_IDS`: sólo identificadores, con el
  nombre y la descripción en `ach.<id>.name` / `.desc`.
- Los capítulos del Syndicate son datos —condiciones y efectos—; la escena y
  las opciones viven en `syn.<capítulo>.text` y `syn.<capítulo>.<opción>`.
- Los uniformes sólo aportan color; el nombre está en `kit.<id>`.
- Clima, estilo de juego y carácter del entrenador se traducen
  (`weather.*`, `style.*`, `trait.*`) en lugar de enseñar el identificador.
- Se añadió una prueba que arma esas claves **desde los propios datos**: si
  se añade un capítulo, un uniforme o un estilo sin texto, la batería falla.
  La prueba anterior sólo veía `t('clave')` literal, y estas se construyen
  con plantillas.

Verificado recorriendo una carrera entera en inglés —creación de árbitro,
logros, previa, partido completo, informe y epílogo— sin que se cuele una
sola palabra en castellano.

## La deriva de los penaltis

Al medir de nuevo tras todos los cambios, los penaltis estaban en **0,63 por
partido**: dos veces y media los 0,25 reales, y en contra de lo que decía esta
misma tabla. La prueba de rangos no lo cazó porque permitía de 0 a 1,2, y con
seis partidos un suceso tan raro no da señal.

El reglamento no tenía la culpa: lo que fallaba era **con qué frecuencia se
daban los hechos que lo activan**.

1. **Manos.** Un 12 % de las manos se generaban como «parada deliberada», que
   por reglamento siempre es infracción —y penalti dentro del área—, y un 18 %
   con el brazo por encima del hombro, igual de automático. Parar el balón con
   la mano a propósito dentro de tu área es un acto desesperado y rarísimo, y
   quien bloquea a bocajarro lo hace con los brazos pegados al cuerpo. Con esa
   distinción, los penaltis por mano bajaron de 0,45 a 0,07 por partido.
2. **Entradas.** El defensor dentro de su propia área sabe que una falta es
   penalti: sólo entra cuando llega claramente al balón. Las faltas en el área
   pasaron de 0,35 a 0,28 por partido.
3. **Criterio del árbitro automático.** El fallo más gordo: si no veía bien
   una jugada que **no era falta** dentro del área, señalaba penalti *siempre*.
   Ningún árbitro hace eso; ante la duda se deja seguir. Ahora sólo compra la
   protesta el 28 % de las veces. Los penaltis inventados cayeron de 0,33 a
   0,05 por partido.

Resultado: **0,63 → 0,35 por partido**, medido sobre 60 partidos.

Las dos primeras causas quedan fijadas con pruebas deterministas y baratas
(`test/engine.test.js`), comprobadas deshaciendo el arreglo para ver que
fallan de verdad. El número final por partido no se puede vigilar en una
prueba unitaria sin volverla lenta o inestable: para eso está
`node test/run.js 60`.

## Los tiros y la conversión

Corregidos los penaltis, la desviación que quedaba eran los tiros: 31,6 por
partido contra los 24-28 reales, y encima con una conversión del 6 %, muy por
debajo del 10 % real. Medir el reparto por distancia lo explicó todo:

| Distancia | Antes | Ahora | Real |
|---|---|---|---|
| Dentro del área (<16 m) | 37 % | **51 %** | ~55 % |
| Frontal (16-22 m) | 42 % | 39 % | ~30 % |
| Lejanos (>22 m) | 22 % | **10 %** | <15 % |

La causa: la urgencia por disparar era **lineal** en la calidad del tiro, así
que un jugador a 25 metros disparaba casi tanto como uno a 12. Ahora cae con
el cuadrado largo de la calidad (`sq ** 2.1`) y hay un mínimo por debajo del
cual no se dispara. Tiros: 31,6 → 28,0.

Al bajar los tiros lejanos bajaron también los goles, y apareció el segundo
problema: **el portero paraba el 84 %** de lo que le llegaba a puerta, cuando
en el fútbol real se para en torno al 70 %. Con la base de parada corregida,
la conversión pasó del 6,2 % al 10,1 %, que es justo la real.

El reparto por distancia queda fijado con una prueba (`test/engine.test.js`),
verificada deshaciendo el arreglo para comprobar que falla de verdad.

## El penalti que se lanza

Con los penaltis ya en su frecuencia real, quedaba comprobar algo que nunca se
había medido: cuántos se marcan. Salía el 72,3 % con atributos medios, contra
el 75-78 % real. Poca cosa, pero corregible: la base pasa de 0,62 a 0,70 y el
lanzador tipo se queda en el 74,8 %.

La primera versión de la prueba no servía: medía el mundo del banco de
pruebas, y la tasa variaba diez puntos según qué lanzador y qué portero
tocaran (78,3 % en un mundo, 83,3 % en otro), así que no distinguía el valor
viejo del nuevo. La definitiva fija los atributos y mide el modelo, no la
suerte del sorteo.

## Las amarillas, y una excusa que no se sostenía

Estas notas decían que las amarillas salían bajas (2,2 por partido, contra 3-5
reales) «porque son las que el árbitro automático no ve, que es exactamente lo
que debe pasar». Al comprobarlo, la explicación era medio verdad y medio
excusa: el reglamento **sí** pedía 4,5 amonestaciones por partido —el rango
real—, pero sólo se mostraban 1,6. Se perdían dos tercios, y eso no es un
árbitro falible: es un modelo mal hecho.

Dos causas, las dos corregidas:

1. **La tarjeta era una segunda tirada a ciegas.** El mismo incidente pasaba
   dos veces por el «¿lo ha visto?»: una para pitar la falta y otra para
   decidir la tarjeta, independientes. Pero para llegar a la segunda el
   árbitro ya ha pitado, ha parado el juego y se ha acercado al jugador:
   juzga con más información, no con la misma.
2. **El nivel del árbitro pesaba igual en una jugada clarísima que en una
   dudosa.** Con la fórmula anterior, un árbitro decente fallaba una falta
   clara de cada tres. Ahora lo que ve depende sobre todo de la jugada, y su
   nivel decide en las dudosas, que es como funciona de verdad.

Al corregirlo aparecieron 0,47 rojas por partido (real 0,1-0,2): con más
amarillas, más segundas amarillas. Y ahí salió otra cosa que el motor no
modelaba: **un jugador amonestado entraba exactamente igual que uno limpio**.
Ahora mide la entrada (`sim.tackleCaution`), y las rojas vuelven a 0,30.

Amarillas: 2,2 → 3,4. Y de paso los goles pasaron de 2,98 a 2,67, justo en el
valor real, porque un árbitro que pita lo que debe cambia el ritmo del partido.

### Sobre medir

Al comparar el antes y el después de la primera corrección salió 1,6 → 2,6, y
era mentira: el cambio consumía **dos tiradas del generador en vez de una**, y
eso desplaza toda la secuencia del partido. Reescrito para consumir una sola,
la mejora real de ese primer arreglo era 1,6 → 1,85. Cuando el motor es
determinista por semilla, cualquier cambio en cuántos números se piden falsea
la comparación.

## La roja que nunca se veía

Persiguiendo las expulsiones apareció un defecto de interfaz, y era mío: una
**segunda amarilla emitía el evento con `card: 'yellow'`**, así que en pantalla
salía una cartulina amarilla mientras el jugador se iba expulsado. La roja no
aparecía nunca. Ahora se emiten las dos, como hace el árbitro de verdad:
enseña la amarilla y después la roja. Comprobado en el navegador —amarilla,
amarilla, roja— y fijado con una prueba.

## Las rojas: la causa estaba en la pérdida de tiempo

Las rojas iban a 0,35 por partido (real 0,1-0,2). Dos intentos fallaron antes
de encontrar la causa, y el primero enseñó más que el arreglo: hacer al
árbitro reticente a la segunda amarilla **no cambiaba absolutamente nada**
—suprimiéndola siempre salían las mismas 0,35 exactas—, porque las tarjetas no
llegan por esa vía. Se quitó ese código en lugar de dejarlo fingiendo.

Midiendo con el banco correcto —el que mueve al árbitro— salió el reparto:
**todas las rojas eran dobles amarillas, ninguna directa**, y de las amarillas
**1,63 por partido eran por pérdida de tiempo**, el 43% del total, cuando en el
fútbol real son 0,3-0,5.

El motivo: el retraso se calculaba sumando el acumulado entero más un margen,
así que salía casi siempre por encima de los 12 segundos que el reglamento
considera descarados. Es decir, **toda demora que llegaba al árbitro ya era
amonestable**, cuando la mayoría deberían quedarse en advertencia. Corregido el
cálculo, la pérdida de tiempo baja a 0,63 amarillas por partido y las rojas a
**0,17: dentro de rango**.

De paso subieron las entradas para acercar las faltas: 20,1 → 21,7, a las
puertas del rango real (22-26).

## El fuera de juego se juzgaba en el momento equivocado

Persiguiendo los fueras de juego (2,5 por partido frente a los 3-5 reales)
apareció un fallo de reglamento: **se medía la posición del receptor al
recibir, no en el instante en que se jugó el balón**, que es lo que dice la
regla. Con eso, un delantero que arrancaba desde atrás y recibía adelantado
salía «fuera de juego», y uno que partía adelantado y esperaba salía
habilitado: justo al revés. Ahora la instantánea del pase guarda también dónde
estaba cada atacante, y hay una prueba con los dos casos.

Eso corrige el criterio, pero **no arregla el número**, y conviene decir por
qué: en el motor casi no hay pases a la espalda de la defensa. El margen
mediano de las recepciones es de -15 m, es decir, se recibe siempre muy por
detrás de la línea, así que no hay ocasión de estar en fuera de juego.

Intenté añadir desmarques a la espalda —los delanteros atacando el hueco y el
pase buscándolos— y **el remedio fue peor**: los goles cayeron de 2,6 a 1,8 y
los tiros de 26 a 20, porque el balón se iba al hueco y lo recogía la defensa,
y los fueras de juego no se movieron ni una décima. Se revirtió. Que un
delantero corra a la espalda y **reciba** ahí exige un modelo de ataque bastante
más fino (temporizar la carrera con el pase); queda anotado como lo que falta,
no como algo que se pueda ajustar con una constante.

## Qué no está y por qué

- **Repetición del partido entero** (no sólo las jugadas guardadas): exigiría
  almacenar los 90 minutos completos, unos 40 MB por partido. Se guarda lo que
  de verdad se revisa.
- **Multijugador y clasificaciones en línea**: fuera del alcance del proyecto,
  que es de un jugador y funciona sin conexión.

## Rediseño de interfaz y gráficos

Ejecutado con la disciplina de Hallmark (género *atmospheric*, macroestructura
*Workbench* para la carrera y *Broadcast overlay* para el partido, tema propio
en OKLCH). Registro en `.hallmark/log.json`.

- Todo el color y toda la tipografía salen de `styles/tokens.css`; ni la
  interfaz ni el canvas escriben un valor a mano.
- Tipografía 2+1 con stacks del sistema: display condensada (rótulos),
  sans del sistema (lectura) y mono tabular (reloj, marcador, notas). Sin
  fuentes remotas: el juego funciona sin conexión.
- Estadio dibujado a mano: cuenco de gradas con aforo proporcional, público
  que vibra con el ruido, focos, banquillos, banderines y redes.
- Durante una decisión la cámara se acerca, un foco aísla la jugada y el
  resto del campo se atenúa.
- Atajos `1`–`6` visibles sobre los propios botones de decisión.
- Verificado a 375 px sin scroll horizontal; `prefers-reduced-motion`
  colapsa todas las animaciones.

## Errores corregidos durante el desarrollo

1. **Partidos colgados**: el reanudado tras una interrupción usaba `setTimeout`,
   que nunca se dispara dentro del bucle síncrono de simulación. Ahora se evalúa
   en el propio tick (`_tickStopped`).
2. **19 rojas por partido**: los umbrales de gravedad y el cálculo de brutalidad
   estaban desbocados; también DOGSO y "ataque prometedor" se activaban casi en
   cada falta.
3. **150 faltas por partido**: las entradas se intentaban cada pocos segundos y
   casi todas producían contacto sancionable.
4. **Cero córners**: no existían desvíos, y las paradas devolvían siempre el
   balón al campo.
5. **Partidos sin ocasiones en categorías bajas**: atributos absolutos
   demasiado bajos; resuelto con la compresión por categoría.
6. **Equipaciones indistinguibles**: ahora el visitante cambia de color si
   choca con el local (`state.colorDistance`).
7. **Notas infladas**: un árbitro con la mitad de decisiones falladas sacaba 8,4.
   Se reescaló la nota y se redujo la indulgencia por mala visibilidad.
8. **Examen predecible**: la respuesta correcta caía casi siempre en la misma
   posición. Ahora las opciones se barajan.
9. **HUD visible en el menú**: `HUD.build()` borraba la clase `hidden`.
10. **Equipaciones que seguían confundiéndose**: el umbral de contraste era
    demasiado bajo y la alternativa podía ser otro tono cercano. Ahora se
    recorre una lista de candidatos hasta garantizar separación; verificado
    sobre los 380 emparejamientos de Primera.
11. **Etiquetas sin traducir en el informe** (`advantage`, `management`) y
    decisiones mostradas con su nombre interno (`challenge → foul`). Ahora
    todo pasa por `t()` y se lee en lenguaje de árbitro.
12. **Plaga de penaltis al llenar el área** en las jugadas a balón parado: los
    defensores seguían entrando al hombre con el balón por alto. Ahora saltan.
13. **Bloqueos contados por tick**: un mismo defensor bloqueaba el mismo balón
    decenas de veces por partido. Ahora hay espera por jugador y sólo se
    bloquea si el balón viene hacia él.
14. **Despejes que iban a las manos del portero**: el despeje de apuro se
    dirigía hacia la portería propia. Ahora busca el banderín.
15. **Los escenarios no empezaban donde decían.** «Minuto 90, empate 1-1»
    arrancaba en el minuto 0 porque `engine.start()` reseteaba el reloj y la
    parte. Lo destapó una prueba en navegador que esperaba un partido corto y
    se quedaba esperando noventa minutos. Ahora el motor respeta el punto de
    partida del escenario y hay una prueba que lo comprueba.
16. **La última jugada del partido se quedaba sin repetición**: los clips se
    cerraban unos segundos después del incidente y el partido terminaba antes.
    Ahora se vuelcan al pitido final.
17. **Cámaras de repetición que enfocaban la grada**: los planos cerrados se
    salían del campo. La cámara se mantiene dentro de los límites.
18. **Sprites animados que se leían como una mancha**: la primera versión
    ponía la cabeza en el centro del torso y el dorsal encima, así que el
    jugador parecía una pelota de color carne. La cabeza pasó al frente, el
    torso manda en el dibujo y el dorsal se redujo.
19. **El público costaba 85.000 rectángulos por fotograma**: se redibujaba
    entero cada vez. Ahora es una capa cacheada que sólo se rehace al cambiar
    la escala o el aforo, y la vibración es un desplazamiento del conjunto.
20. **El partido de fondo del menú no se veía**: el velo de las pantallas es
    casi opaco. Ahora el menú usa un velo más claro (`#screens.airy`) y el
    resto de pantallas detiene la simulación de fondo.
