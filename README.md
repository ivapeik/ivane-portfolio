# Ivane Peikrishvili, portfolio

A small static site: plain HTML, one CSS file and two JavaScript files. No build step, no libraries.

## Pages

| File           | What it is                                              |
| -------------- | ------------------------------------------------------- |
| `index.html`   | Home: the 3D turntable hero                             |
| `about.html`   | CV: profile, details, education, skills, projects, contact |

## Folders

```
css/style.css       all styles, in numbered sections (tokens at the top)
js/turntable.js     the WebGL turntable on the home page
js/main.js          small shared things: footer year, age, print CV
assets/             turntable atlas and portraits
```

## Run it locally

Open the folder with a local server, for example:

```
npx serve .
```

or VS Code's Live Server. Opening `index.html` straight from disk works too, but browsers
block the turntable photos on `file://`, so you will see a still portrait instead of the turn.

## Things to fill in

- Education years or programme names: see the comment in `about.html`
- Tools under each layer (home page) and in Skills (about page): adjust to your real stack

## How the turntable works

`assets/turntable.webp` holds 40 frames of the figure, one every 9 degrees (10 columns x 4 rows,
260 x 844 px each). Every 5th frame is one of the 8 original photos; the frames in between are
warped copies of the nearest original. The camera orbits a small WebGL stage. The figure always
comes to rest on an original photo and only passes through in-between frames while turning.

To move the figure on screen, change `--fig-x`, `--fig-top` and `--fig-bottom` on `.hero`
in `css/style.css`. The script reads them on every resize.

Visitors with "reduce motion" switched on get no opening animation and no automatic turning.
