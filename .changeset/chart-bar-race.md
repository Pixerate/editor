---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Chart editor: bar chart races, for parity with Ursula's chart documents. The new `barrace` type reads categories as time points and series as names and draws the top `raceTopN` names at one moment as ranked horizontal bars; values ease and places slide between time points, gaps carry the last value, and bar keys follow the series so scenes blend. The moment is controller view state (`ChartState.raceFrame`, `racePlaying`) set with `setRaceFrame`, `playRace` and `pauseRace` (the `raceTicker` option swaps the clock), and `layoutChart` takes `raceFrame` to draw any moment. New helpers `chartRaceRanking`, `chartRaceValueAt`, `chartRaceMoment`; agent tools `get_chart_race_ranking`, `set_chart_race_frame` and `play_chart_race`, `render_chart` takes `time`, and `chart.raceRanking`, `chart.setRaceFrame`, `chart.playRace` and `chart.pauseRace` commands. The recommender suggests a race for many series over time. The React and Svelte canvases draw the moment shown, and the inspectors add Play / Pause, a time scrubber and a Bars setting.
