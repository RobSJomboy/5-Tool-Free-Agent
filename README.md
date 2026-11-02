# The 5-Tool Free Agent

Talkin' Baseball segment: drag this winter's free agents into a five-circle Venn of the five tools
(HIT · POWER · SPEED · ARM · GLOVE), then let Baseball Savant check the hosts' work.

- `control.html` — the producer's page. Player pool on the left (live MLB free-agent feed, plus search
  for any MLB hitter), a live preview of the display you drag players onto, and the spotlight / Savant
  check buttons. **Copy OBS URL** gives the display link.
- `display.html?room=…` — 1920×1080 OBS Browser Source, full frame under the Talkin' Baseball frame. Everything is drawn
  inside a safe area between the two host cameras (default x 400–1520, measured off a show frame grab); adjust it live in
  control, which draws the camera boxes over its preview. Add `&bg=clear` for a transparent background.

Data is fetched live at page load: free agents + 2026/career stats + WAR from MLB StatsAPI, tool grades
from Baseball Savant percentile rankings (2025 used when a player barely played in 2026). A tool's grade
is the mean of its Savant percentiles on the 20–80 scouting scale; "plus tool" threshold is set in control.
Control and display sync through the Jomboy Cloudflare relay.
