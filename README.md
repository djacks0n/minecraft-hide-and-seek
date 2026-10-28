# Minecraft Hide and Seek

A live game board for Jet Lag style Hide and Seek in Minecraft. Both players open the same link and see the same wheels, timers, questions, and scores.

## Files

- `index.html` is the game page
- `server.js` serves the page and syncs each game room
- `package.json` tells Render how to start it

## Running on Render

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

## Playing

Open the site and it makes a room code (like `#K7QM`). Hit **Copy invite link** and send it to your friend. Anyone with that link joins the same game.

The free Render plan sleeps after about 15 minutes with nobody on it, so the first visit after that can take a minute to load. Each player's browser also keeps a copy of the game, so if the server restarts mid-game it picks back up from whoever reconnects first.

## Minecraft add-on

`addon/HideAndSeek.mcaddon` is the same game as an in-game Bedrock add-on (behavior pack + resource pack). The site serves it at `/HideAndSeek.mcaddon`. The unzipped pack folders are next to it in `addon/`.
