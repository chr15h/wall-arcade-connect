import { startAppSafely } from '../shell/app.js';
import { refreshWall } from '../shell/wall-data.js';
import { unbreakableAdapter } from '../games/unbreakable/client.js';

(window as unknown as { __arcadeBoot?: string }).__arcadeBoot = 'ran';   // the module evaluated (see the boot guard in index.html)
void refreshWall();
startAppSafely(unbreakableAdapter);
