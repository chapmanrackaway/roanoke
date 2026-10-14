# Rides to Vote

Interactive maps that help Virginia voters find a bus from home to their polling place. It's modeled on [Transit to Turnout](https://transittoturnout.org/) in Charlottesville. There's one page per city:

| City | Page | Buses |
|---|---|---|
| Roanoke | `/roanoke/` | Valley Metro |
| Radford | `/radford/` | Radford Transit |

The site's front page links to each city.

## How it works for voters

1. **Where do you live?** Enter the home address from your voter registration, use your phone's location, or tap the map.
2. **Where do you vote?** Pick your precinct from the list (it's printed on your voter card). Where the city publishes precinct boundaries (Roanoke does), the site suggests a precinct from your address and asks you to confirm it. A link goes to the state's voter lookup for anyone who isn't sure. The early-voting office appears in the list until early voting ends.
3. **When do you want to leave?** Choose a departure time during polling hours.

The site then shows:

- up to three bus itineraries (one bus or one transfer), each with walking steps, departure and arrival times, and the route drawn on the map
- a **Plan my trip home** button for the return trip
- the bus routes near your home and near your polling place
- a note when walking would be quicker, and a warning when a trip arrives after polls close
- a Google Maps transit link to compare against

Trip planning runs entirely in the browser. The address search goes to OpenStreetMap's Nominatim geocoder, and nothing is stored.

## Project layout

```
cities/<city>/site.json           Election date, poll hours, early voting, bus feed URLs, links, wording
cities/<city>/polling-places.json The city's polling places (edit this when locations change)
scripts/build-data.mjs            Builds each city's page and data from live sources
scripts/lib/gtfs.mjs              Turns the GTFS feed into a compact Election Day schedule
site/                             The static website (deployed after the build)
site/template.html                The trip planner page; the build writes a copy to site/<city>/index.html
site/js/router.js                 The trip planner (a small RAPTOR search over the schedule)
site/js/app.js                    Map, form, and results UI (shared by every city)
test/                             Unit tests with a small made-up GTFS fixture
```

The build writes `site/index.html`, `site/<city>/index.html`, and `site/<city>/data/`. These are generated, so they're not in git.

## Data sources

| Data | Source | When it's fetched |
|---|---|---|
| Roanoke bus routes, stops, schedules | Valley Metro GTFS feed (`https://vmgoapp.com/gtfs`), with the [MobilityDatabase](https://mobilitydatabase.org/) mirror as a fallback | At build time |
| Radford bus routes, stops, schedules | Radford Transit GTFS feed from Trillium (`https://data.trilliumtransit.com/gtfs/radford-va-us/radford-va-us.zip`), with the MobilityDatabase mirror as a fallback | At build time |
| Roanoke polling places | [City of Roanoke, Voting Precincts and Polling Places](https://www.roanokeva.gov/3166/Voting-Precincts-and-Polling-Places), copied into `cities/roanoke/polling-places.json` | Edited by hand |
| Radford polling places | City of Radford elections office (see `source` in `cities/radford/polling-places.json`) | Edited by hand |
| Polling-place coordinates | US Census geocoder, with Nominatim as a fallback | At build time |
| Precinct boundaries (optional, Roanoke only) | City of Roanoke GIS (`gis03.roanokeva.gov`, Voter_Precincts layer) | At build time |
| Address search, map tiles | OpenStreetMap | In the visitor's browser |

Each schedule is built for Election Day (`election.date` in the city's `site.json`). If the agency's feed doesn't cover that date yet, the build uses the nearest date in the feed that falls on the same weekday, and the site shows a banner saying so.

Precinct boundaries are only used to suggest a precinct. A polygon is kept only if its name matches a current precinct in the city's `polling-places.json`, so an outdated layer can fail to suggest a precinct but can't suggest one that no longer exists. If the layer can't be fetched, voters just pick their precinct from the list.

## Running it locally

Requires Node 20 or newer and internet access.

```sh
npm install
npm run build        # copies Leaflet into site/vendor and builds site/data/
npm run serve        # http://localhost:8080
npm test
```

`npm run serve` shows the city picker; the cities are at `/roanoke/` and `/radford/`.

To build one city, add `--city`: `node scripts/build-data.mjs --city radford`. To build from a GTFS file you already have, run `node scripts/build-data.mjs --city radford --gtfs path/to/feed.zip`. The flags `--skip-geocode` and `--skip-precincts` skip those steps.

## Deploying (GitHub Pages)

`.github/workflows/deploy.yml` runs the tests, builds every city, and publishes `site/` to GitHub Pages. It runs on every push to `main`, every morning (to pick up schedule changes), and on demand. To turn it on:

1. Go to **Settings → Pages** in the repository.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to `main`, or start the workflow from the **Actions** tab.

If a source is down during a build, the build fails and the previously deployed site stays up.

## Updating for a new election

For each city:

1. Update `election` (and `earlyVoting`) in `cities/<city>/site.json`.
2. Check `cities/<city>/polling-places.json` against the city's polling place information and update the `checked` date.
3. If the geocoder puts a polling place in the wrong spot, add `"lat"` and `"lon"` to that entry. The build keeps coordinates you set by hand.
4. Push. The workflow rebuilds the schedules for the new date.

## Adding a city

1. Copy `cities/radford/` to `cities/<new-city>/` (the folder name becomes the page's URL).
2. Fill in `site.json`: names and wording, map center and search area, the agency's GTFS URLs, election dates, and links. Add `transit.fareNote` if the buses are fare-free, and `precinctBoundaries.url` if the city publishes precinct polygons.
3. List the polling places in `polling-places.json`.
4. Run `npm run build` and check the new page.

## Disclaimer

This is an independent, nonpartisan tool. It isn't run by the City of Roanoke, the City of Radford, the Virginia Department of Elections, Valley Metro, or Radford Transit. Voters should confirm their polling place with official sources.
