# ts-11plus
Tiny Spark 11 plus Exam Practice App


A Flask web app for 11+ practice: about 1,550 original questions across maths, English, verbal reasoning and non-verbal reasoning, with instant answer explanations, plus **Spark Stumble**, a knockout race game where answering questions is the control scheme. Progress is saved in the browser on that device; no account or database is required.

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
flask --app app run --debug
```

Open <http://127.0.0.1:5000/>. On Windows, activate with `.venv\Scripts\activate`.

## Run the tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

## Deploy

The app is one small Flask service (no database, no secrets, no environment variables needed). It listens on `$PORT` and exposes `/healthz` for health checks. Progress is stored in each child's browser, so it scales horizontally and needs no persistent disk.

- **Render (easiest, free tier):** push this repo to GitHub, then in Render choose *New → Blueprint* and select the repo. `render.yaml` sets everything up. (Free instances sleep after inactivity, so the first load can take ~30 s.)
- **Heroku / Railway / Fly.io style hosts:** the `Procfile` runs `gunicorn app:app`. Fly: `fly launch` then `fly deploy` (it will pick up the `Dockerfile`).
- **Any container host:** `docker build -t tiny-spark . && docker run -p 8000:8000 tiny-spark`.

After deploying, open the site on a phone, choose *Add to Home Screen* and it installs like an app and works offline (service worker). The site serves everything from its own origin under a strict Content-Security-Policy; it loads no third-party scripts, fonts or analytics. Always serve over HTTPS (all the hosts above do), which the install and offline features require.

To change the questions, edit the generators in `tools/qbank/` and run `python -m tools.qbank`. Regenerate the icons with `python -m tools.make_icons`.

## Project layout

- `app.py` creates the Flask app: pages, the cached question bank (`/questions.js`), PWA manifest and service worker, `/healthz` and security headers.
- `data/questions.json` holds subject labels, questions, answers and explanations. Each question is `[prompt, options, correct_option_index, explanation, [topic, level]]`, where level 1–3 is the difficulty used by Spark Stumble.
- `templates/index.html` is the practice page; it loads the bank from `/questions.js`.
- `static/style.css` and `static/practice.js` provide the design and quiz behaviour.
- `templates/stumble.html`, `static/stumble.css` and `static/stumble.js` are **Spark Stumble** (`/stumble`), the game mode below.
- `tools/qbank/` generates `data/questions.json` (`python -m tools.qbank`). `gl_maths.py`, `gl_english.py`, `gl_vr.py` and `gl_nvr.py` hold the GL-style question families described below.

## Spark Stumble (game mode)

A Stumble Guys style knockout race where answering questions is the control scheme. 32 runners (you plus 31 bots) race through three rounds (Qualifier 32→20, Semi-final 20→10, Grand Final 10→1 crown). Each course has question gates: a right answer gives a speed boost, a wrong answer or a time-out makes your bean stumble. Bots have a skill level that adapts a little to how you have been playing, and each wrong answer is explained on the end-of-run summary.

Coins, crowns, XP, level, hats and colour are saved in the browser (`localStorage`, key `sparkstumble-v1`). The question bank is shared with practice mode; long reading passages (over ~420 characters of text) are skipped because they are unfair in a timed race. Tunable constants (round sizes, gate counts, gate time, bot speeds) are at the top of `static/stumble.js`.

### Balancing

Difficulty is set by how long bots think per gate (`botThinkBase() + (1 − skill) × 13 + up to 5 s`) and how often they are right. A Monte-Carlo of the race model showed the outcome is very sensitive to these numbers, so change them together and re-simulate rather than by feel. With the current values a child who takes ~12 s per question and is right 70% of the time qualifies ~93% of the time and reaches the final about half the time. A child who takes ~10 s wins the crown roughly 1 game in 4, and a fast, accurate child wins nearly every time. Bots speed up as the child's recent accuracy rises, and ease slightly after several early knock-outs.

## GL-style questions

Real 11+ (GL Assessment) papers use a fixed set of question *types*. The `gl_*.py` generators write **original** questions of those types (no text is copied from any published paper): joining-letter and move-a-letter word puzzles, double-bracket synonyms, deductive item puzzles, interleaved/accelerating sequences; timetables, 24-hour time, bar/pie charts, tables, pictograms, discounts, ratios, decimals, mass and shape properties; comprehension passages, words in context, cloze, spelling and punctuation; and SVG lines-of-symmetry, square counting, shape codes, rotations and shape analogies. Questions have four options (the papers use five) to fit the game's answer buttons. Maths, VR and NVR items are generated with the correct answer computed in code; English and the word lists are hand-written.

The sample questions are illustrative, not official exam papers. For production, review the material against the intended 11+ exam and add more questions to avoid repetition.
