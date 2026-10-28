# NFT INVADERS' raiders: waves of XCOPY (CC0)

Display only: the engine and the verifier never see this art. `../art.ts` draws it: one XCOPY series per wave, in turn.

**NFT INVADERS is a fan-made game: it is not made by, endorsed by or affiliated with XCOPY.** CC0 frees the works, not the name or any endorsement: the game names XCOPY only as the artist of the works
(the wave banner says "CC0 ART BY XCOPY · NOT AFFILIATED", the (i) panel says it in full), never in its title or tagline.
Keep it that way in any description of the game (the hub card, posts).

XCOPY's own statement, https://xcopy.art/creative-commons: *"XCOPY works are licensed under CC0 (Public Domain), free to
use, remix, and build upon. Derivative and collaborative works may have different rights retained by the original
artist."*

## In the game

- **`xcopy.json`**: 60 works in six series (MAX PAIN AND FRENS, TRAITORS, SUPERRARE 2019, FRESH HELL, SUPERRARE 2020–23,
  EARLY WORKS), up to 12 each, reduced to 96 × 96 (an animated GIF to its first frame), taken from a saved copy of
  xcopy.art's Works page (`Works.docx`) by `scripts/xcopy-works-art.ts`. Releases that may be collaborations or curated
  by others are left out: The Memes by 6529, CoinDesk Most Influential, Kolectiv, NFT Boxes, Async Art (2020), Deca,
  Noble Gallery, PixelChain.
- **`grifters.json`**: fourteen Grifters (December 2021, Async Art Blueprint `0xc143bbfcdbdbed6d454803804752a064a622c1f3`,
  666 editions, issued and signed by XCOPY), read from the chain and IPFS by `scripts/raiders-art.ts` and reduced from
  3840 × 3840 to 96 × 96.

Where a work sits on a black ground, that ground is cut away (`scripts/cutout.ts`: only the black connected to the
picture's edge, so the blacks inside a figure, its eyes and outlines, stay) and the figure is drawn free; a work on any
other ground keeps a round frame.

## CC0 INVADERS: other CC0 collections (`../art-cc0.ts`)

**NFT INVADERS' line-up since its second release** (also CC0 INVADERS'), one collection per wave, in turn: Nouns, MAX PAIN AND
FRENS (XCOPY), CrypToadz, TRAITORS (XCOPY), mfers, EARLY WORKS (XCOPY). **A fan-made game: it is not made by, endorsed by
or affiliated with any of these projects or artists** (its wave banners say "NOT AFFILIATED", its (i)
panel says it in full).

- `nouns-image-data.json`: the Nouns artwork (Nouns DAO, CC0), from
  [nounsDAO/nouns-monorepo](https://github.com/nounsDAO/nouns-monorepo/blob/master/packages/nouns-assets/src/image-data.json);
  `../art-cc0.ts` draws a Noun on the fly from its run-length encoded parts (a palette byte, the bounds top/right/bottom/left
  of a 32 × 32 box, then length/colour runs filling it row by row).
- `cryptoadz.json` (CrypToadz by Gremplin, CC0: "Gremplin waived all copyright and related rights") and `mfers.json`
  (mfers by sartoshi, CC0; second-hand sources only: **confirm before launch**), built by `scripts/raiders-art.ts`, their
  plain-colour grounds cut away when that leaves a clean figure (12 of 14 toadz, 13 of 14 mfers).
