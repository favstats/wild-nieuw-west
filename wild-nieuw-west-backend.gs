/**
 * Wild Nieuw-West - Murder Mystery Party Backend
 * Google Apps Script Backend
 *
 * This backend ONLY handles multiplayer coordination:
 * - Game creation & joining
 * - Player list & character claiming
 * - Death reporting (shared counter)
 * - Game status (waiting/active)
 *
 * All game logic (tasks, timers, roles) lives in the frontend.
 *
 * SETUP:
 * 1. Go to script.google.com and create a new project
 * 2. Copy this file into the editor
 * 3. Deploy > New Deployment > Web app > Execute as Me > Anyone
 * 4. Copy the URL into index.html API_URL
 * 5. Create a Google Sheet and put its ID below
 */

// ==================== CONFIGURATION ====================
const SHEET_ID = '1XH8ET223rMkytntL75_-9tGfAg-HGvmSk6aYYFJnJb4';
const GAMES_SHEET = 'Games';
const PLAYERS_SHEET = 'Players';

// ==================== CHARACTERS (easily replaceable) ====================
// These are sent to the frontend so players can pick. Roles are secret.
const CHARACTERS = [
  { name: 'Contessa Valentina', role: 'murderer' },
  { name: 'Professor Aldric', role: 'detective' },
  { name: 'Baroness Eloise', role: 'innocent' },
  { name: 'Captain Mortimer', role: 'murderer' },
  { name: 'Madame Séraphine', role: 'detective' },
  { name: 'Lord Pemberton', role: 'innocent' },
  { name: 'Dr. Faust', role: 'innocent' },
  { name: 'Lady Blackwood', role: 'innocent' },
  { name: 'Signor Rinaldi', role: 'innocent' },
  { name: 'Miss Clementine', role: 'innocent' },
  { name: 'Colonel Ashworth', role: 'innocent' },
  { name: 'Duchess Margaux', role: 'innocent' },
  { name: 'Henrik the Butler', role: 'innocent' },
  { name: 'Rosa the Maid', role: 'innocent' },
  { name: 'Father Ignatius', role: 'innocent' },
  { name: 'Vivienne the Singer', role: 'innocent' },
];

// ==================== WEB APP ENTRY POINTS ====================

function doGet(e) {
  return handleRequest(e.parameter);
}

function doPost(e) {
  let params = {};
  try {
    if (e.postData && e.postData.contents) {
      params = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    params = e.parameter || {};
  }
  return handleRequest(params);
}

function handleRequest(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    const action = params.action;
    let result;

    switch(action) {
      case 'createGame':
        result = createGame(params.hostName);
        break;
      case 'joinGame':
        result = joinGame(params.gameCode, params.playerName, params.characterName, params.isHost);
        break;
      case 'getPlayers':
        result = getPlayers(params.gameCode);
        break;
      case 'startGame':
        result = startGame(params.gameCode, params.hostId);
        break;
      case 'reportDeath':
        result = reportDeath(params.gameCode, params.playerId, params.lastWords);
        break;
      case 'getGameState':
        result = getGameState(params.gameCode, params.playerId);
        break;
      case 'lightsOut':
        result = lightsOut(params.gameCode, params.hostId, params.enabled);
        break;
      case 'sendNote':
        result = sendNote(params.gameCode, params.fromPlayerId, params.toCharacter, params.message);
        break;
      case 'getMyNotes':
        result = getMyNotes(params.gameCode, params.characterName);
        break;
      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }

    output.setContent(JSON.stringify(result));
  } catch (error) {
    output.setContent(JSON.stringify({
      success: false,
      error: error.toString()
    }));
  }

  return output;
}

// ==================== GAME FUNCTIONS ====================

/**
 * Create a new game. Returns character list (names only, roles hidden).
 */
function createGame(hostName) {
  if (!hostName) {
    return { success: false, error: 'Host name is required' };
  }

  const ss = SpreadsheetApp.openById(SHEET_ID);
  ensureSheetsExist(ss);

  const gameCode = generateGameCode();
  const hostId = generatePlayerId();
  const timestamp = new Date().toISOString();

  // Store characters in configData (roles stay server-side secret)
  // Only create game row — host joins via joinGame like everyone else
  const gamesSheet = ss.getSheetByName(GAMES_SHEET);
  gamesSheet.appendRow([
    gameCode,
    hostId,
    'waiting',
    timestamp,
    '',
    JSON.stringify({ characters: CHARACTERS, hostName: hostName })
  ]);

  return {
    success: true,
    gameCode: gameCode,
    hostId: hostId,
    isHost: true,
    characters: CHARACTERS.map(function(c) { return c.name; })
  };
}

/**
 * Join a game by picking a character (or entering custom name).
 * Role is determined by character config but only revealed on startGame.
 */
function joinGame(gameCode, playerName, characterName, isHost) {
  if (!gameCode || !playerName) {
    return { success: false, error: 'Game code and player name are required' };
  }

  gameCode = gameCode.toUpperCase().trim();

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const gamesSheet = ss.getSheetByName(GAMES_SHEET);
  const playersSheet = ss.getSheetByName(PLAYERS_SHEET);

  // Find game
  const gamesData = gamesSheet.getDataRange().getValues();
  let gameExists = false;
  let gameStatus = '';
  let configData = {};

  for (let i = 1; i < gamesData.length; i++) {
    if (gamesData[i][0] === gameCode) {
      gameExists = true;
      gameStatus = gamesData[i][2];
      try { configData = JSON.parse(gamesData[i][5] || '{}'); } catch(e) {}
      break;
    }
  }

  if (!gameExists) return { success: false, error: 'Game not found' };

  // If game is active, allow rejoining with existing character
  if (gameStatus !== 'waiting') {
    if (characterName) {
      const playersData = playersSheet.getDataRange().getValues();
      for (let i = 1; i < playersData.length; i++) {
        if (playersData[i][0] === gameCode && playersData[i][3] === characterName) {
          // Return existing player data for rejoin
          return {
            success: true,
            gameCode: gameCode,
            playerId: playersData[i][1],
            characterName: playersData[i][3],
            isHost: playersData[i][4] === true || playersData[i][4] === 'TRUE',
            rejoin: true
          };
        }
      }
    }
    return { success: false, error: 'Game has already started' };
  }

  // Check character not taken (during waiting phase)
  if (characterName) {
    const playersData = playersSheet.getDataRange().getValues();
    for (let i = 1; i < playersData.length; i++) {
      if (playersData[i][0] === gameCode && playersData[i][3] === characterName) {
        return { success: false, error: 'That character is already taken' };
      }
    }
  }

  // Determine role from config (stored but not revealed yet)
  let role = 'innocent';
  if (characterName && configData.characters) {
    const charConfig = configData.characters.find(function(c) { return c.name === characterName; });
    if (charConfig) role = charConfig.role;
  }

  const playerId = generatePlayerId();
  const timestamp = new Date().toISOString();

  // Columns: gameCode, playerId, playerName, characterName, isHost, role, isDead, joinedAt
  playersSheet.appendRow([
    gameCode,
    playerId,
    playerName,
    characterName || playerName,
    isHost === 'true' || isHost === true,
    role,
    false,
    timestamp
  ]);

  return {
    success: true,
    gameCode: gameCode,
    playerId: playerId,
    characterName: characterName || playerName,
    isHost: false
  };
}

/**
 * Get player list + game status. Roles NOT exposed.
 */
function getPlayers(gameCode) {
  if (!gameCode) return { success: false, error: 'Game code is required' };

  gameCode = gameCode.toUpperCase().trim();

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const gamesSheet = ss.getSheetByName(GAMES_SHEET);
  const playersSheet = ss.getSheetByName(PLAYERS_SHEET);

  // Game status
  const gamesData = gamesSheet.getDataRange().getValues();
  let gameStatus = 'waiting';

  for (let i = 1; i < gamesData.length; i++) {
    if (gamesData[i][0] === gameCode) {
      gameStatus = gamesData[i][2];
      break;
    }
  }

  // Players (no roles!)
  const playersData = playersSheet.getDataRange().getValues();
  const players = [];
  const takenCharacters = [];

  for (let i = 1; i < playersData.length; i++) {
    if (playersData[i][0] === gameCode) {
      players.push({
        id: playersData[i][1],
        name: playersData[i][2],
        characterName: playersData[i][3],
        isHost: playersData[i][4] === true || playersData[i][4] === 'TRUE',
        isDead: playersData[i][6] === true || playersData[i][6] === 'TRUE'
      });
      if (playersData[i][3]) takenCharacters.push(playersData[i][3]);
    }
  }

  return {
    success: true,
    players: players,
    gameStatus: gameStatus,
    started: gameStatus === 'active',
    takenCharacters: takenCharacters
  };
}

/**
 * Host starts the game. Returns each player's role (only to the requesting host,
 * who broadcasts nothing — each client fetches their own role via getGameState).
 */
function startGame(gameCode, playerId) {
  if (!gameCode || !playerId) {
    return { success: false, error: 'Game code and player ID are required' };
  }

  gameCode = gameCode.toUpperCase().trim();

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const gamesSheet = ss.getSheetByName(GAMES_SHEET);

  // Verify host
  const gamesData = gamesSheet.getDataRange().getValues();
  let gameRow = -1;
  let hostId = '';

  for (let i = 1; i < gamesData.length; i++) {
    if (gamesData[i][0] === gameCode) {
      gameRow = i + 1;
      hostId = gamesData[i][1];
      break;
    }
  }

  if (gameRow === -1) return { success: false, error: 'Game not found' };
  if (hostId !== playerId) return { success: false, error: 'Only the host can start the game' };

  // Count players
  const playersSheet = ss.getSheetByName(PLAYERS_SHEET);
  const playersData = playersSheet.getDataRange().getValues();
  let playerCount = 0;
  for (let i = 1; i < playersData.length; i++) {
    if (playersData[i][0] === gameCode) playerCount++;
  }

  // Set game to active
  const timestamp = new Date().toISOString();
  gamesSheet.getRange(gameRow, 3).setValue('active');
  gamesSheet.getRange(gameRow, 5).setValue(timestamp);

  return {
    success: true,
    message: 'Game started!',
    playerCount: playerCount
  };
}

/**
 * Toggle a player's death status.
 */
function reportDeath(gameCode, playerId, lastWords) {
  if (!gameCode || !playerId) {
    return { success: false, error: 'Game code and player ID are required' };
  }

  gameCode = gameCode.toUpperCase().trim();

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const playersSheet = ss.getSheetByName(PLAYERS_SHEET);
  const playersData = playersSheet.getDataRange().getValues();

  for (let i = 1; i < playersData.length; i++) {
    if (playersData[i][0] === gameCode && playersData[i][1] === playerId) {
      const currentlyDead = playersData[i][6] === true || playersData[i][6] === 'TRUE';
      const newStatus = !currentlyDead;
      playersSheet.getRange(i + 1, 7).setValue(newStatus);

      // Store last words if dying (not un-dying)
      if (newStatus && lastWords) {
        // Store in Messages sheet as a broadcast
        ensureSheetsExist(ss);
        const messagesSheet = ss.getSheetByName('Messages');
        const charName = playersData[i][3];
        messagesSheet.appendRow([
          gameCode, 'SYSTEM', '', 'LAST WORDS from ' + charName + ': "' + lastWords + '"',
          new Date().toISOString(), 'lastwords'
        ]);
      }

      return { success: true, isDead: newStatus, characterName: playersData[i][3] };
    }
  }

  return { success: false, error: 'Player not found' };
}

/**
 * Get game state for polling: player list with death status, game status,
 * and the requesting player's own role (if game is active).
 */
function getGameState(gameCode, playerId) {
  if (!gameCode) return { success: false, error: 'Game code is required' };

  gameCode = gameCode.toUpperCase().trim();

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const gamesSheet = ss.getSheetByName(GAMES_SHEET);
  const playersSheet = ss.getSheetByName(PLAYERS_SHEET);

  // Game status + configData
  const gamesData = gamesSheet.getDataRange().getValues();
  let gameStatus = 'waiting';
  let configData = {};

  for (let i = 1; i < gamesData.length; i++) {
    if (gamesData[i][0] === gameCode) {
      gameStatus = gamesData[i][2];
      try { configData = JSON.parse(gamesData[i][5] || '{}'); } catch(e) {}
      break;
    }
  }

  // All players
  const playersData = playersSheet.getDataRange().getValues();
  const players = [];
  let deathCount = 0;

  for (let i = 1; i < playersData.length; i++) {
    if (playersData[i][0] === gameCode) {
      const isDead = playersData[i][6] === true || playersData[i][6] === 'TRUE';
      if (isDead) deathCount++;

      const playerEntry = {
        id: playersData[i][1],
        name: playersData[i][2],
        characterName: playersData[i][3],
        isHost: playersData[i][4] === true || playersData[i][4] === 'TRUE',
        isDead: isDead
      };

      // Only include roles when game is active (so clients can fetch their own)
      if (gameStatus === 'active') {
        playerEntry.role = playersData[i][5];
      }

      players.push(playerEntry);
    }
  }

  // Get recent messages for this player
  var messages = [];
  try {
    var messagesSheet = ss.getSheetByName('Messages');
    if (messagesSheet) {
      var msgData = messagesSheet.getDataRange().getValues();
      var myChar = '';
      if (playerId) {
        for (var p = 0; p < players.length; p++) {
          if (players[p].id === playerId) { myChar = players[p].characterName; break; }
        }
      }
      // Get messages from last 2 minutes (for polling)
      var twoMinAgo = Date.now() - 120000;
      for (var m = 1; m < msgData.length; m++) {
        if (msgData[m][0] === gameCode) {
          var msgTime = new Date(msgData[m][4]).getTime();
          if (msgTime > twoMinAgo) {
            var toChar = msgData[m][2];
            var msgType = msgData[m][5];
            // Show if: broadcast (toChar empty), lastwords, or addressed to me
            if (!toChar || toChar === myChar || msgType === 'lastwords') {
              messages.push({
                from: msgData[m][1],
                to: toChar,
                message: msgData[m][3],
                time: msgData[m][4],
                type: msgType
              });
            }
          }
        }
      }
    }
  } catch(e) {}

  return {
    success: true,
    status: gameStatus,
    started: gameStatus === 'active',
    deathCount: deathCount,
    totalPlayers: players.length,
    alivePlayers: players.length - deathCount,
    players: players,
    lightsOut: configData.lightsOut || false,
    messages: messages
  };
}

/**
 * Host toggles Lights Out mode
 */
function lightsOut(gameCode, hostId, enabled) {
  if (!gameCode || !hostId) return { success: false, error: 'Game code and host ID required' };

  gameCode = gameCode.toUpperCase().trim();

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const gamesSheet = ss.getSheetByName(GAMES_SHEET);
  const gamesData = gamesSheet.getDataRange().getValues();

  for (let i = 1; i < gamesData.length; i++) {
    if (gamesData[i][0] === gameCode) {
      if (gamesData[i][1] !== hostId) return { success: false, error: 'Only the host can control lights' };

      var configData = {};
      try { configData = JSON.parse(gamesData[i][5] || '{}'); } catch(e) {}
      configData.lightsOut = (enabled === 'true' || enabled === true);
      gamesSheet.getRange(i + 1, 6).setValue(JSON.stringify(configData));

      return { success: true, lightsOut: configData.lightsOut };
    }
  }
  return { success: false, error: 'Game not found' };
}

/**
 * Send an anonymous note to another player
 */
function sendNote(gameCode, fromPlayerId, toCharacter, message) {
  if (!gameCode || !fromPlayerId || !toCharacter || !message) {
    return { success: false, error: 'All fields required' };
  }

  gameCode = gameCode.toUpperCase().trim();
  message = message.substring(0, 200); // Limit length

  const ss = SpreadsheetApp.openById(SHEET_ID);
  ensureSheetsExist(ss);
  const messagesSheet = ss.getSheetByName('Messages');

  messagesSheet.appendRow([
    gameCode,
    'Anonymous',
    toCharacter,
    message,
    new Date().toISOString(),
    'note'
  ]);

  return { success: true, message: 'Note sent' };
}

/**
 * Get notes for a specific character
 */
function getMyNotes(gameCode, characterName) {
  if (!gameCode || !characterName) return { success: false, error: 'Game code and character required' };

  gameCode = gameCode.toUpperCase().trim();

  const ss = SpreadsheetApp.openById(SHEET_ID);
  var messagesSheet = ss.getSheetByName('Messages');
  if (!messagesSheet) return { success: true, notes: [] };

  var msgData = messagesSheet.getDataRange().getValues();
  var notes = [];

  for (var i = 1; i < msgData.length; i++) {
    if (msgData[i][0] === gameCode && (msgData[i][2] === characterName || msgData[i][5] === 'lastwords')) {
      notes.push({
        from: msgData[i][1],
        message: msgData[i][3],
        time: msgData[i][4],
        type: msgData[i][5]
      });
    }
  }

  return { success: true, notes: notes };
}

// ==================== UTILITY FUNCTIONS ====================

function ensureSheetsExist(ss) {
  let gamesSheet = ss.getSheetByName(GAMES_SHEET);
  if (!gamesSheet) {
    gamesSheet = ss.insertSheet(GAMES_SHEET);
    gamesSheet.appendRow(['gameCode', 'hostId', 'status', 'createdAt', 'startedAt', 'configData']);
  }

  let playersSheet = ss.getSheetByName(PLAYERS_SHEET);
  if (!playersSheet) {
    playersSheet = ss.insertSheet(PLAYERS_SHEET);
    playersSheet.appendRow(['gameCode', 'playerId', 'playerName', 'characterName', 'isHost', 'role', 'isDead', 'joinedAt']);
  }

  let messagesSheet = ss.getSheetByName('Messages');
  if (!messagesSheet) {
    messagesSheet = ss.insertSheet('Messages');
    messagesSheet.appendRow(['gameCode', 'from', 'toCharacter', 'message', 'timestamp', 'type']);
  }
}

function generateGameCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const numbers = '0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  for (let i = 0; i < 2; i++) {
    code += numbers.charAt(Math.floor(Math.random() * numbers.length));
  }
  return code;
}

function generatePlayerId() {
  return 'p_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}

function testSetup() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  ensureSheetsExist(ss);
  Logger.log('Setup complete! Sheets: ' + GAMES_SHEET + ', ' + PLAYERS_SHEET);
  Logger.log('Characters: ' + CHARACTERS.map(function(c) { return c.name; }).join(', '));
}
