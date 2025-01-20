import {
    world,
    system,
    Player
} from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

// Configuration constants
const PLOT_SIZE = {
    width: 20,
    length: 20,
    height: 319
};

const CONFIG = {
    EMPTY_PLOT_STRUCTURE_NAME: "empty_plot",
    SAVE_INTERVAL: 1, // Auto-save every 1 seconds
    SAVE_ATTEMPTS: 3,
    DEBUG_MODE: true,
    Y_LEVEL_SNAP: 4  // How many blocks to snap Y level to
};

// Database management using world dynamic properties
class PlotDatabase {
    static getStorageKey(playerId) {
        return `plot_data_${playerId}`;
    }

    static save(playerId, plotData) {
        try {
            const dataToSave = {
                ...plotData,
                lastSaved: Date.now()
            };
            world.setDynamicProperty(
                this.getStorageKey(playerId),
                JSON.stringify(dataToSave)
            );
            return true;
        } catch (error) {
            console.error(`Database save error: ${error.message}`);
            return false;
        }
    }

    static load(playerId) {
        try {
            const data = world.getDynamicProperty(this.getStorageKey(playerId));
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error(`Database load error: ${error.message}`);
            return null;
        }
    }

    static delete(playerId) {
        try {
            world.setDynamicProperty(this.getStorageKey(playerId), undefined);
            return true;
        } catch (error) {
            console.error(`Database delete error: ${error.message}`);
            return false;
        }
    }
}

// In-memory storage for runtime
const activePlots = new Map(); // Maps plot coordinates to player IDs
const playerPlots = new Map(); // Maps player IDs to their plot data
const uiOpen = new Map(); // Track UI state

class Logger {
    static log(message, player = null) {
        if (CONFIG.DEBUG_MODE) {
            console.warn(`[PlotManager] ${message}`);
        }
        if (player) {
            player.sendMessage(`§e${message}`);
        }
    }

    static error(message, player = null) {
        console.error(`[PlotManager] Error: ${message}`);
        if (player) {
            player.sendMessage(`§c${message}`);
        }
    }
}

class PlotManager {
    constructor() {
        this.initializeEventListeners();
        this.setupAutoSave();
    }

    setupAutoSave() {
        system.runInterval(() => {
            this.saveAllActivePlots();
        }, CONFIG.SAVE_INTERVAL * 20); // Convert seconds to ticks
    }

    async saveAllActivePlots() {
        for (const [playerId, plotData] of playerPlots) {
            const player = [...world.getAllPlayers()].find(p => p.id === playerId);
            if (player) {
                try {
                    await this.savePlotState(player, true);
                    Logger.log(`Auto-saved plot for ${player.name}`);
                } catch (error) {
                    Logger.error(`Auto-save failed for ${player.name}: ${error.message}`);
                }
            }
        }
    }

    initializeEventListeners() {
        world.beforeEvents.chatSend.subscribe((eventData) => {
            if (eventData.message.startsWith("!plot")) {
                eventData.cancel = true;
                if (uiOpen.get(eventData.sender.name)) {
                    return;
                }
                eventData.sender.sendMessage("§e→ Opening Plot Management menu...");
                system.run(() => {
                    this.openPlotUI(eventData.sender);
                });
            }
        });

        world.afterEvents.playerLeave.subscribe((eventData) => {
            const playerName = eventData.playerName;
            const playerId = Array.from(playerPlots.keys()).find(id => {
                const player = [...world.getAllPlayers()].find(p => p.id === id);
                return player && player.name === playerName;
            });

            if (playerId) {
                const plotData = playerPlots.get(playerId);
                if (plotData) {
                    const player = [...world.getAllPlayers()].find(p => p.id === playerId);
                    if (player) {
                        this.savePlotState(player, true);
                    }
                    activePlots.delete(this.getPlotKey(plotData.location));
                    playerPlots.delete(playerId);
                }
            }
        });
    }

    openPlotUI(player) {
        const plotForm = new ActionFormData()
            .title("§l§8Plot Management")
            .body("§7Welcome to the plot management system!\n\n§fSelect an option below to manage your plot:")
            .button("§2§lCLAIM PLOT\n§r§aGet a new plot")
            .button("§4§lUNCLAIM PLOT\n§r§cRemove your current plot");

        system.run(() => {
            uiOpen.set(player.name, true);
            system.runTimeout(() => {
                plotForm.show(player).then((response) => {
                    uiOpen.set(player.name, false);
                    if (response.cancelationReason === "UserBusy") {
                        system.run(() => {
                            this.openPlotUI(player);
                        });
                        return;
                    }
                    if (response.canceled) return;

                    switch (response.selection) {
                        case 0:
                            this.claimPlot(player);
                            break;
                        case 1:
                            this.unclaimPlot(player);
                            break;
                    }
                });
            }, 1);
        });
    }

    async validatePlotSpace(player, location) {
        try {
            // Check if there's enough clear space for the plot
            const testCommand = `testforblock ~~~ air`;
            await player.runCommandAsync(testCommand);
            return true;
        } catch (error) {
            return false;
        }
    }

    async claimPlot(player) {
        const currentLocation = this.getNearestPlotLocation(player.location);

        // Add distance check to ensure player is actually near the plot
        const distanceX = Math.abs(player.location.x - (currentLocation.x + PLOT_SIZE.width / 2));
        const distanceZ = Math.abs(player.location.z - (currentLocation.z + PLOT_SIZE.length / 2));
        const distanceY = Math.abs(player.location.y - currentLocation.y);
        
        if (distanceX > PLOT_SIZE.width || distanceZ > PLOT_SIZE.length || distanceY > PLOT_SIZE.height) {
            Logger.error("§4✖ §cYou must be standing closer to the plot you want to claim!", player);
            return;
        }

        if (!this.isValidPlotLocation(currentLocation)) {
            Logger.error("§4✖ §cInvalid plot location", player);
            return;
        }

        const plotKey = this.getPlotKey(currentLocation);
        if (activePlots.has(plotKey)) {
            Logger.error("§4✖ §cThis plot is already claimed!", player);
            return;
        }

        if (playerPlots.has(player.id)) {
            Logger.error("§4✖ §cYou already have a claimed plot! Use the unclaim option first.", player);
            return;
        }

        try {
            await this.resetPlotToEmpty(player, currentLocation);
            const savedPlotData = PlotDatabase.load(player.id);

            if (savedPlotData) {
                try {
                    await player.runCommandAsync(
                        `structure load "plot_${player.id}" ${currentLocation.x} ${currentLocation.y} ${currentLocation.z} 0_degrees none block_by_block`
                    );
                    player.sendMessage("§2✔ §aYour saved plot has been loaded!");
                } catch (loadError) {
                    Logger.error("§6⚠ §eFailed to load saved plot, starting fresh", player);
                }
            } else {
                player.sendMessage("§2✔ §aStarting with a fresh plot!");
            }

            const plotData = {
                location: currentLocation,
                structureName: `plot_${player.id}`
            };
            activePlots.set(plotKey, player.id);
            playerPlots.set(player.id, plotData);
            PlotDatabase.save(player.id, plotData);

        } catch (error) {
            Logger.error(`§4✖ §cFailed to claim plot: ${error.message}`, player);
        }
    }

    async unclaimPlot(player) {
        const plotData = playerPlots.get(player.id);
        if (!plotData) {
            Logger.error("§4✖ §cYou don't have a claimed plot!", player);
            return;
        }

        try {
            await this.savePlotState(player, true);
            await this.resetPlotToEmpty(player, plotData.location);

            activePlots.delete(this.getPlotKey(plotData.location));
            playerPlots.delete(player.id);

            player.sendMessage("§2✔ §aPlot unclaimed and saved successfully!");
        } catch (error) {
            Logger.error(`§4✖ §cFailed to unclaim plot: ${error.message}`, player);
        }
    }

    isValidPlotLocation(location) {
        return (
            location &&
            typeof location.x === 'number' &&
            typeof location.y === 'number' &&
            typeof location.z === 'number' &&
            location.y >= -64 &&
            location.y <= 320
        );
    }

    getNearestPlotLocation(position) {
        // Snap to plot grid for X and Z
        const plotGridX = Math.floor(position.x / PLOT_SIZE.width);
        const plotGridZ = Math.floor(position.z / PLOT_SIZE.length);
        
        const finalX = plotGridX * PLOT_SIZE.width;
        const finalZ = plotGridZ * PLOT_SIZE.length;
        
        // Snap Y to the nearest valid level while keeping it within bounds
        let snappedY = Math.round(position.y / CONFIG.Y_LEVEL_SNAP) * CONFIG.Y_LEVEL_SNAP;
        
        // Ensure we have enough height clearance
        const maxY = 320 - PLOT_SIZE.height;
        
        // Adjust Y if too close to height limit
        if (snappedY > maxY) {
            snappedY = maxY;
        }
        
        // Ensure Y is not below minimum
        if (snappedY < -64) {
            snappedY = -64;
        }
        
        return {
            x: finalX,
            y: snappedY,
            z: finalZ
        };
    }

    getPlotKey(location) {
        return `${Math.floor(location.x / PLOT_SIZE.width)},${Math.floor(location.z / PLOT_SIZE.length)}`;
    }

    async savePlotState(player, saveToDatabase = false) {
        const plotData = playerPlots.get(player.id);
        if (!plotData) return;

        for (let attempt = 1; attempt <= CONFIG.SAVE_ATTEMPTS; attempt++) {
            try {
                const saveCommand =
                    `structure save "plot_${player.id}" ` +
                    `${plotData.location.x} ${plotData.location.y} ${plotData.location.z} ` +
                    `${plotData.location.x + PLOT_SIZE.width - 1} ` +
                    `${plotData.location.y + PLOT_SIZE.height - 1} ` +
                    `${plotData.location.z + PLOT_SIZE.length - 1} ` +
                    `true disk`;

                await player.runCommandAsync(saveCommand);

                if (saveToDatabase) {
                    PlotDatabase.save(player.id, plotData);
                }

                return;
            } catch (error) {
                if (attempt === CONFIG.SAVE_ATTEMPTS) {
                    throw new Error(`Failed to save plot after ${CONFIG.SAVE_ATTEMPTS} attempts: ${error.message}`);
                }
                await new Promise(resolve => system.runTimeout(resolve, 40));
            }
        }
    }

    async resetPlotToEmpty(player, location) {
        if (!this.isValidPlotLocation(location)) {
            throw new Error("Invalid plot location provided for reset");
        }

        try {
            await player.runCommandAsync(
                `structure load "${CONFIG.EMPTY_PLOT_STRUCTURE_NAME}" ${location.x} ${location.y} ${location.z} 0_degrees none block_by_block`
            );
        } catch (error) {
            throw new Error(`Failed to reset plot: ${error.message}`);
        }
    }
}

// Initialize the plot manager
const plotManager = new PlotManager();

export { plotManager };