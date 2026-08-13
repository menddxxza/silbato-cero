# SILBATO CERO

Simulador 2D de carrera arbitral. No controlas a los futbolistas: controlas al
árbitro. El partido se juega solo, en tiempo real, y tú decides.

Todo el contenido —clubes, jugadores, entrenadores, estadios, competiciones y
narrativa— es **ficticio y original**. No se usan marcas, escudos, nombres ni
assets de terceros.

## Cómo jugarlo

No hay compilación ni dependencias: son módulos ES nativos.

```bash
python3 -m http.server 8099     # o cualquier servidor estático
# abrir http://localhost:8099
```

(Debe servirse por HTTP, no con `file://`, por las restricciones de módulos ES.)

**Sin conexión.** Tras la primera carga el juego se instala entero en la caché
del navegador: se puede jugar con la red apagada, y desde el móvil se añade a
la pantalla de inicio como una aplicación más. La lista de ficheros del casco
vive en `sw.js`, y hay una prueba que falla si se añade un módulo y se olvida
meterlo ahí —que es exactamente como se rompe el modo sin conexión.

### Controles

| Tecla | Acción |
|---|---|
| `WASD` / flechas | mover al árbitro |
| `SHIFT` | esprintar (consume físico) |
| `ESPACIO` | pausa |
| `C` | cámara fija / cámara que sigue el balón |
| `1`–`6` | elegir opción durante una decisión |

También se juega con **mando** (palanca izquierda para moverte, gatillo o A para
esprintar, los cuatro botones frontales y los gatillos superiores para las seis
opciones de decisión, Start pausa, Select cambia la cámara) y con **pantalla
táctil** (palanca virtual y botón de sprint, que sólo aparecen en dispositivos
sin teclado). En un teléfono en vertical el campo se gira para llenar la
pantalla, y la dirección de la palanca gira con él.

Tu **posición importa**: la distancia, el ángulo y los cuerpos interpuestos
determinan lo que realmente ves, y por tanto tu probabilidad de acertar.

## Trabajar en equipo

`CONTRIBUTING.md` cuenta en una página cómo arrancar, qué probar antes de
subir nada y dónde vive cada cosa. Lo esencial:

- Se trabaja en ramas que salen de `main` y se fusionan ahí con una
  *pull request*.
- Las 83 pruebas se ejecutan solas en cada push y en cada pull request
  (`.github/workflows/pruebas.yml`) y tienen que estar en verde.
- Hay plantillas de pull request y de incidencia para no dejarse lo
  importante: pruebas, texto en los dos idiomas, y el fichero nuevo dado de
  alta en la caché sin conexión.

## Pruebas

```bash
node test/all.js       # 90 pruebas: reglamento, sistemas y motor
node test/all.js -v    # con el detalle de cada prueba
node test/run.js 60      # 60 partidos de una jornada de liga normal
node test/run.js 40 copa # eliminatorias y partidos calientes: todo sube
```

- **Reglamento** (38): casos de las reglas del juego. Si una falla, el juego
  estaría enseñando una regla equivocada.
- **Sistemas** (29): generación del mundo, equipaciones distinguibles, guardado
  y carga, economía, academia y —lo más útil al añadir texto— que los dos
  idiomas tengan las mismas claves y que la interfaz no use ninguna
  inexistente. También que los efectos del campo caduquen, que el movimiento
  se apague con `prefers-reduced-motion` y que la caché sin conexión liste
  exactamente los ficheros que hay en disco.
- **Motor** (23): invariantes del partido (nadie sale del campo, la posesión
  cuadra, nunca quedan menos de siete jugadores, el mismo partido con la misma
  semilla da el mismo resultado) y que las medias caen en rangos creíbles.

## Arquitectura

```
.
├── index.html            punto de entrada
├── styles/tokens.css     sistema de diseño (color OKLCH, tipografía, espacio)
├── styles/main.css       estilo propio, construido sólo sobre tokens
├── i18n/                 es.js · en.js  (ningún texto vive en la lógica)
├── sw.js                 caché sin conexión · manifest.webmanifest · icon.svg
├── test/run.js           banco de pruebas headless
└── src/
    ├── core/             rng (semillas) · events · config · i18n · save
    ├── data/             names · generators · formations · examQuestions · scenarios
    ├── rules/            ruleEngine.js  ← todo el criterio reglamentario
    ├── match/            state · sim · incidents · matchEngine · rating · var · assistants
    ├── ai/               autoReferee (partidos sin jugador)
    ├── career/           career · referee · academy · press · achievements · syndicate
    ├── ui/               renderer · hud · screens
    ├── audio/            audio.js (WebAudio, sin ficheros)
    └── game.js           controlador y máquina de estados
```

Reglas de diseño que se respetan en todo el proyecto:

- **Los datos no viven en el código.** Clubes, plantillas y competiciones se
  generan desde una semilla (`generateWorld`), y las preguntas de examen y los
  escenarios son datos.
- **Las reglas no viven en la interfaz.** `ruleEngine.js` es el único sitio con
  criterio arbitral: `evaluateFoul`, `evaluateHandball`, `evaluateOffside`,
  `evaluatePenalty`, `evaluateAdvantage`, `evaluateDisciplinaryAction`,
  `evaluateRestart`, `evaluateGoal`, `gradeDecision`, `varShouldIntervene`.
- **El motor no dibuja.** `matchEngine` emite eventos; la UI escucha.
- **Los textos no viven en la lógica.** Siempre `t('clave')`.

## Qué simula

### Partido

Los 22 jugadores y el balón se simulan en metros sobre un campo de 105×68 con
paso fijo. Cada equipo tiene formación, estilo, presión, anchura, ritmo y
agresividad; los jugadores tienen atributos y personalidad (agresividad,
disciplina, simulación, temperamento, profesionalidad) y un estado emocional que
cambia durante el partido.

Los incidentes **emergen del juego**: un duelo se resuelve por atributos,
velocidad y estado del terreno, y de ahí sale —o no— una infracción. No hay
`randomEvent()` cada X segundos.

### Decisión

Cada incidente lleva una *verdad* reglamentaria oculta y una *claridad* calculada
a partir de tu posición. La botonera cambia según la situación: dentro del área
no se ofrece lo mismo que en el centro del campo.

La calificación es matizada: acertar la falta y fallar la tarjeta no es lo mismo
que inventarse un penalti. Cuatro niveles: correcta, mayormente correcta,
discutible, incorrecta.

### Sistemas implementados

Ventaja real (con memoria del infractor para amonestarlo después) · tarjetas con
advertencia verbal previa · manos evaluadas por posición del brazo, distancia y
naturalidad · fuera de juego con asistentes falibles que pueden dudar · VAR con
cuatro cámaras, control de reproducción fotograma a fotograma, línea de fuera de
juego y protocolo de error claro y manifiesto · tecnología de línea de gol ·
bloqueos y rechaces dentro del área · remates de cabeza · barrera a 9,15 m en
las faltas y área llena en los córners · reiteración de faltas · pérdida de
tiempo del equipo que va ganando ·
lesiones y equipo médico · sustituciones · descuento calculado dinámicamente
(sin cortar una ocasión clara) · prórroga y tanda de penaltis · protestas de
jugadores y entrenadores según personalidad · eventos de estadio (tangana,
objetos, apagón, tormenta, cánticos discriminatorios) con protocolo y posible
suspensión · clima que afecta al balón, a los resbalones y a la visibilidad.

### Carrera

Nueve categorías, de la Liga Regional Iberania al Campeonato Mundial, con más de
100 clubes y 16 selecciones. Cada jornada eliges entre designaciones con su
presión, dificultad, rivalidad, honorarios y experiencia.

Economía con dos caras: honorarios por partido frente a un coste fijo por
jornada que crece con la categoría, y siete inversiones con efecto real
(gimnasio, fisio, coche, piso, curso de reglamento, equipamiento y analista de
vídeo). Nota, reputación, experiencia, condición física y diez atributos que
suben entrenando y arbitrando. Ascensos y descensos por rendimiento sostenido,
condicionados a aprobar los exámenes de la academia. Prensa que titula según lo
que pasó de verdad, ruedas de prensa, blog con audiencia, supervisor arbitral,
decisiones éticas, modo Syndicate ramificado y ocho finales distintos.

### Repetición

Las jugadas con peso (goles, tarjetas, penaltis, revisiones VAR y todo lo
calificado como de impacto alto) se guardan mientras dura el partido. Desde el
informe final se abren en un reproductor con control fotograma a fotograma,
cuatro cámaras y línea de fuera de juego.

### Modos

Carrera oficial · Syndicate · Classic (partido suelto configurable) · Escenarios
· Partidos históricos · Academia · Tutorial.

## Dificultad

`Fácil · Normal · Difícil · Experto · Realista`. Al subir: incidentes más
ambiguos, asistentes menos fiables, menos pistas (en Realista, ninguna), menos
tiempo para decidir, más presión y nota más exigente.

## Sistema de diseño

`styles/tokens.css` es la única fuente de color, tipografía, espacio y
movimiento. Ni la interfaz ni el renderizador de canvas escriben un color a
mano: el césped, las líneas y la noche del estadio salen de los mismos tokens
que los paneles, así que nunca se desincronizan.

- **Paleta** OKLCH anclada en `oklch(15% .018 250)` (noche azulada bajo focos)
  con un único acento cálido, `oklch(80% .15 78)`, el ámbar del silbato.
- **Tipografía 2+1**: display sans condensada para rótulos de retransmisión,
  sans del sistema para lectura y monoespaciada tabular para reloj, marcador y
  notas. Todo son stacks del sistema: el juego funciona sin conexión.
- **Movimiento**: tres curvas nombradas, sólo `transform` y `opacity`, y
  colapso completo bajo `prefers-reduced-motion` —también en el canvas, donde
  los sprites siguen dibujándose pero dejan de agitarse.
- Durante una decisión el campo se atenúa y un foco cae sobre la jugada: la
  vista acompaña a la decisión en lugar de competir con ella.

## Animación

Nada se dibuja quieto.

- **Jugadores y árbitros** tienen cuerpo: torso con el color del equipo,
  cabeza asomando hacia donde miran, y piernas y brazos que se alternan con la
  zancada. La cadencia la marca la velocidad real de cada uno, y cada jugador
  arranca con su propia fase para que veintidós piernas no marchen al unísono.
  El cuerpo bota al correr y la sombra se encoge con el bote. Un lesionado se
  dibuja tumbado; quien protesta o celebra levanta los brazos.
- **El balón** rueda en proporción a lo que recorre y se aplasta un instante
  al caer con fuerza. Cuando va rápido deja estela.
- **El partido** responde: el marcador rueda al cambiar, la nota se desplaza
  hacia su valor en vez de saltar, un gol lanza el rótulo de retransmisión y
  papelillos en la grada del equipo que marcó, cada tarjeta tiñe el borde de
  la pantalla y se levanta sobre el infractor, y cada decisión sale del
  silbato como una onda. El banderín del asistente sube y ondea.
- **En los menús hay partido.** El campo del fondo no es una imagen: es un
  encuentro real jugándose con árbitro automático, desenfocado bajo el velo.
  Se detiene en cuanto entras en cualquier otra pantalla.
- Las repeticiones animan igual: la zancada sale de lo que se movió cada
  jugador entre fotogramas, así que al rebobinar las piernas rebobinan.

Para que todo eso quepa en 60 FPS, el público, el halo de los focos y la
viñeta se dibujan una vez en capas aparte y luego se estampan: antes eran
decenas de miles de rectángulos y cuatro degradados por fotograma. El coste
de dibujo bajó de 68 ms a 14 ms por fotograma en el mismo banco de pruebas.

## Accesibilidad

- El documento declara el idioma que se está leyendo de verdad: cambiar a
  inglés cambia `<html lang>`, del que dependen la pronunciación de los
  lectores de pantalla y la separación silábica.
- El campo es un lienzo, que por sí solo no dice nada: lleva encima una
  descripción con el marcador y el minuto, que se actualiza cada minuto.
- Los avisos del partido se anuncian solos (`role="status"`), y el panel de
  decisión se anuncia entero y sin esperar en cuanto aparece, porque hay un
  reloj corriendo.
- Las seis opciones de decisión se eligen con `1`–`6`: el partido se arbitra
  sin soltar el teclado.
- Todo el movimiento se apaga con `prefers-reduced-motion`.

## Añadir un idioma

La arquitectura está preparada: los textos viven en `i18n/`, nunca en la lógica.

1. Copia `i18n/es.js` a `i18n/fr.js` (por ejemplo) y traduce los valores.
2. Regístralo en `src/core/i18n.js` (`BUNDLES`).
3. Ejecuta `node test/all.js`: las pruebas de idiomas comprueban que no falte
   ninguna clave, que ninguna esté vacía y que las variables (`{n}`, `{ref}`)
   coincidan entre idiomas.

El juego se entrega en español e inglés, completos y verificados: **ningún
texto vive en el código**, ni siquiera los logros, la trama del Syndicate, los
uniformes, los estilos de juego, el carácter de los entrenadores o el clima.
Comprobado recorriendo una carrera entera en inglés sin que se cuele una sola
palabra en castellano.

## Estado

Terminado y jugable de principio a fin, con 90 pruebas automáticas en verde.
El detalle de lo que quedó dentro y lo que se decidió dejar fuera está en
`NOTAS-DESARROLLO.md`.
