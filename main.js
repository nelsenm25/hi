import { world, system, ItemStack, Player } from "@minecraft/server";

// List of items that cannot be renamed
const RESTRICTED_ITEMS = [
    "minecraft:chicken_spawn_egg",
    "minecraft:netherite_pickaxe",
    "minecraft:netherite_sword",
    "minecraft:diamond_pickaxe"
];

// List of all anvil variants
const ANVIL_TYPES = [
    "minecraft:anvil",
    "minecraft:chipped_anvil",
    "minecraft:damaged_anvil"
];

// Debug mode flag for logging
const DEBUG_MODE = true;

// Track player inventory states
const playerInventoryStates = new Map();

/**
 * Log debug messages to console if debug mode is enabled
 * @param {string} message - Message to log
 */
function debugLog(message) {
    if (DEBUG_MODE) {
        console.warn(`[AnvilRestrictions] ${message}`);
    }
}

/**
 * Send notification message to player
 * @param {Player} player - Player to send message to
 * @param {string} message - Message to send
 */
function notifyPlayer(player, message) {
    player.sendMessage(`§c${message}`);
}

/**
 * Validate block is an anvil
 * @param {Block} block - The block to check
 * @returns {boolean} True if block is an anvil
 */
function isAnvil(block) {
    if (!block?.typeId) {
        debugLog("Invalid block or missing typeId");
        return false;
    }

    debugLog(`Block type: ${block.typeId}`);
    return ANVIL_TYPES.includes(block.typeId);
}

/**
 * Get inventory state for a player
 * @param {Player} player - The player to check
 * @returns {Map<number, string>} Map of slot numbers to item IDs
 */
function getInventoryState(player) {
    const state = new Map();
    const inventory = player.getComponent("inventory");
    if (!inventory) return state;

    for (let i = 0; i < inventory.container.size; i++) {
        const item = inventory.container.getItem(i);
        if (item && RESTRICTED_ITEMS.includes(item.typeId)) {
            state.set(i, item.typeId);
        }
    }
    return state;
}

// Set up interval to check for inventory changes near anvils
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        try {
            // Get the block the player is looking at
            const block = player.getBlockFromViewDirection();
            if (!block?.block || !isAnvil(block.block)) {
                // Clear tracked state if not looking at anvil
                playerInventoryStates.delete(player.id);
                continue;
            }

            // Get current inventory state
            const currentState = getInventoryState(player);
            const previousState = playerInventoryStates.get(player.id);

            // If no previous state, store current state and continue
            if (!previousState) {
                playerInventoryStates.set(player.id, currentState);
                continue;
            }

            // Check for moved items
            let itemMoved = false;
            previousState.forEach((itemId, slot) => {
                if (!currentState.has(slot) || currentState.get(slot) !== itemId) {
                    itemMoved = true;
                }
            });

            if (itemMoved) {
                notifyPlayer(player, "Restricted items cannot be moved while anvil UI is open!");
                debugLog(`Player ${player.name} moved a restricted item in anvil UI`);

                // Force close the anvil UI
                try {
                    player.runCommand("closescreen");
                } catch (cmdError) {
                    debugLog(`Error closing screen: ${cmdError}`);
                }
            }

            // Update stored state
            playerInventoryStates.set(player.id, currentState);
        } catch (error) {
            debugLog(`Error in interval check for player ${player.name}: ${error}`);
        }
    }
}, 10); // Check every 10 ticks (0.5 seconds)

// Subscribe to block interaction event
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    try {
        const { player, block, itemStack } = event;

        debugLog(`Player ${player?.name} interacting with block ${block?.typeId}`);

        // Validate player and block
        if (!player || !block) {
            debugLog("Invalid player or block in event");
            return;
        }

        // Check if block is anvil
        if (!isAnvil(block)) {
            return;
        }

        // Check if player has an item in hand using itemStack from event
        if (!itemStack) {
            event.cancel = true;
            notifyPlayer(player, "You must be holding an item to use the anvil!");
            debugLog(`Player ${player.name} attempted to use anvil with empty hand`);
            return;
        }

        // Check if item is restricted
        if (RESTRICTED_ITEMS.includes(itemStack.typeId)) {
            // Cancel the anvil interaction
            event.cancel = true;
            notifyPlayer(player, "This item cannot be renamed!");
            debugLog(`Player ${player.name} attempted to rename restricted item: ${itemStack.typeId}`);
        }
    } catch (error) {
        debugLog(`Error in event handler: ${error}`);
    }
});

// Monitor item use to detect when items are moved in the anvil UI
world.beforeEvents.itemUse.subscribe((event) => {
    try {
        const { source: player, itemStack } = event;

        if (!player || !itemStack) return;

        // Get the block the player is looking at
        const block = player.getBlockFromViewDirection();
        if (!block?.block || !isAnvil(block.block)) return;

        // If they're using a restricted item near an anvil
        if (RESTRICTED_ITEMS.includes(itemStack.typeId)) {
            event.cancel = true;
            notifyPlayer(player, "This item cannot be renamed!");
            debugLog(`Player ${player.name} attempted to use restricted item in anvil: ${itemStack.typeId}`);

            // Force close the anvil UI
            try {
                player.runCommand("closescreen");
            } catch (cmdError) {
                debugLog(`Error closing screen: ${cmdError}`);
            }
        }
    } catch (error) {
        debugLog(`Error in itemUse handler: ${error}`);
    }
});

// Monitor item use on anvil blocks
world.beforeEvents.itemUseOn.subscribe((event) => {
    try {
        const { source: player, itemStack } = event;

        if (!player || !itemStack) return;

        // Get the block they're using the item on
        const block = player.dimension.getBlock(event.blockLocation);
        if (!block || !isAnvil(block)) return;

        // Check if the item is restricted
        if (RESTRICTED_ITEMS.includes(itemStack.typeId)) {
            event.cancel = true;
            notifyPlayer(player, "This item cannot be renamed!");
            debugLog(`Player ${player.name} attempted to place restricted item in anvil: ${itemStack.typeId}`);
        }
    } catch (error) {
        debugLog(`Error in itemUseOn handler: ${error}`);
    }
});

// System run call to confirm script is loaded
system.run(() => {
    debugLog("Anvil Restrictions Script Loaded Successfully");
    debugLog(`Monitoring ${RESTRICTED_ITEMS.length} restricted items`);
    debugLog("Anvil types monitored: " + ANVIL_TYPES.join(", "));
});