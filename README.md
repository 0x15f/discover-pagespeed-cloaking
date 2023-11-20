# Discover Pagespeed Cloaking

This project aimed to identify common methods used to manipulate Google Lighthouse or Google Pagespeed metrics. It has been tested on 50+ Shopify sites that were manually reviewed, some containing malicious code, others did not. It uses Puppeteer to emulate a normal user and a Lighthouse test, collects various metrics, and weights them to calculate a probability.

## Requirements

- Node v18

## Running the script

1. Run `npm ci`
2. Add your website URL to `WEBSITE_URLS` on line 19 of `index.js`.
3. Run `node index.js`

Five tests will run using Lighthouse and a standard user agent and a score will be printed to the console. Additionally, a `full-results-*.json` file will be created with in-depth test details and full dev tools traces dumped to the `traces` folder.

## Scoring

- Scores less than 35% are typically server rendering or buffering, the Kitsch and Skims baseline tests show this.
- Scores between 50% - 60% indicate some type of malicious manipulation such as excessive lazy loading or some scripts being stripped.
- Scores in the 60% - 80% range indicate heavy manipulation of the page when Lighthouse is running.
- Scores above 80%... DM me that's crazy.

## False Positives

Please report any false positives to me on Twitter @0x15f. I aim to improve this script, implement some form of heuristics using a pre-trained neural network and package this as a web app. However not enough data has been collected to do so.

## Credits / Inspiration

- Lukas "coffeezilla of pagespeed" Tanasiuk (@igobylukas)
- Stackoverflow of course
- Whoever's content was used to train GPT4-turbo.
