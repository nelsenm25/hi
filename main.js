import {
    world,
    system,
    BlockPermutation
} from "@minecraft/server";

// Selection tool configuration
const SELECTION_TOOL = "minecraft:golden_axe";
const COMMAND_PREFIX = "!";
const PLOTS_DATA_KEY = "plots_data_v5"; // Changed to force reset

// Player selection state storage
const playerSelections = new Map();

class PlotData {
    constructor(boundary, owner = "") {
        this.boundary = boundary;
        this.owner = owner;
        this.created = Date.now();
    }

    toJSON() {
        return {
            boundary: this.boundary.toString(),
            owner: this.owner,
            created: this.created
        };
    }

    static fromJSON(data) {
        const plot = new PlotData(
            PlotBoundary.fromString(data.boundary),
            data.owner
        );
        plot.created = data.created;
        return plot;
    }
}

class Location {
    constructor(x = 0, y = 0, z = 0) {
        this.x = Math.floor(Number(x) || 0);
        this.y = Math.floor(Number(y) || 0);
        this.z = Math.floor(Number(z) || 0);
    }

    static fromLocation(location) {
        if (!location) return new Location(0, 0, 0);
        if (location instanceof Vector3) {
            return new Location(location.x, location.y, location.z);
        }
        return new Location(
            Number(location.x) || 0,
            Number(location.y) || 0,
            Number(location.z) || 0
        );
    }

    toString() {
        return `${this.x},${this.y},${this.z}`;
    }

    static fromString(str) {
        if (!str) return new Location(0, 0, 0);
        const [x, y, z] = str.split(',').map(n => parseInt(n) || 0);
        return new Location(x, y, z);
    }

    equals(other) {
        return this.x === other.x &&
            this.y === other.y &&
            this.z === other.z;
    }

    toVector() {
        return new Vector(this.x, this.y, this.z);
    }
}

class PlotBoundary {
    constructor(corner1, corner2) {
        const loc1 = Location.fromLocation(corner1);
        const loc2 = Location.fromLocation(corner2);

        this.min = new Location(
            Math.min(loc1.x, loc2.x),
            Math.min(loc1.y, loc2.y),
            Math.min(loc1.z, loc2.z)
        );

        this.max = new Location(
            Math.max(loc1.x, loc2.x),
            Math.max(loc1.y, loc2.y),
            Math.max(loc1.z, loc2.z)
        );
    }

    containsPoint(point) {
        const loc = Location.fromLocation(point);
        const result = loc.x >= this.min.x && loc.x <= this.max.x &&
            loc.y >= this.min.y && loc.y <= this.max.y &&
            loc.z >= this.min.z && loc.z <= this.max.z;

        if (!result) {
            console.warn(`[Plot System] Point check: ${loc.toString()} against boundary: ${this.toString()}`);
        }
        return result;
    }

    getVolume() {
        return (this.max.x - this.min.x + 1) *
            (this.max.y - this.min.y + 1) *
            (this.max.z - this.min.z + 1);
    }

    toString() {
        return `${this.min.toString()}|${this.max.toString()}`;
    }

    static fromString(str) {
        if (!str) return new PlotBoundary(new Location(), new Location());
        const [min, max] = str.split('|').map(Location.fromString);
        return new PlotBoundary(min, max);
    }

    overlaps(other) {
        return !(this.max.x < other.min.x || this.min.x > other.max.x ||
            this.max.y < other.min.y || this.min.y > other.max.y ||
            this.max.z < other.min.z || this.min.z > other.max.z);
    }
}

class PlotSystem {
    constructor() {
        this.plots = [];
        this.loadPlots();
        this.setupEvents();
    }

    loadPlots() {
        try {
            const savedData = world.getDynamicProperty(PLOTS_DATA_KEY);
            if (savedData) {
                const plotsData = JSON.parse(savedData);
                if (Array.isArray(plotsData)) {
                    this.plots = plotsData.map(plotData => PlotData.fromJSON(plotData));
                    console.warn(`[Plot System] Loaded ${this.plots.length} plots`);
                    this.plots.forEach((plot, i) => {
                        console.warn(`[Plot System] Plot ${i}: ${plot.boundary.toString()}`);
                    });
                }
            }
        } catch (error) {
            console.error("[Plot System] Failed to load plots:", error);
            this.plots = [];
        }
    }

    savePlots() {
        try {
            const plotsData = this.plots.map(plot => plot.toJSON());
            const dataString = JSON.stringify(plotsData);
            world.setDynamicProperty(PLOTS_DATA_KEY, dataString);
            console.warn(`[Plot System] Saved ${this.plots.length} plots`);
            console.warn(`[Plot System] Data: ${dataString}`);
        } catch (error) {
            console.error("[Plot System] Failed to save plots:", error);
        }
    }

    getPlotAt(location) {
        const loc = Location.fromLocation(location);
        console.warn(`[Plot System] Checking location: ${loc.toString()}`);

        for (const plot of this.plots) {
            console.warn(`[Plot System] Testing against plot: ${plot.boundary.toString()}`);
            if (plot.boundary.containsPoint(loc)) {
                console.warn(`[Plot System] Found matching plot!`);
                return plot;
            }
        }

        console.warn(`[Plot System] No plot found at location`);
        return null;
    }

    createPlot(boundary) {
        console.warn(`[Plot System] Creating plot: ${boundary.toString()}`);

        for (const plot of this.plots) {
            if (plot.boundary.overlaps(boundary)) {
                console.warn(`[Plot System] Overlap detected with: ${plot.boundary.toString()}`);
                return null;
            }
        }

        const plot = new PlotData(boundary);
        this.plots.push(plot);

        // Save immediately
        system.run(() => {
            this.savePlots();
            console.warn(`[Plot System] Plot created and saved. Total plots: ${this.plots.length}`);
        });

        return plot;
    }

    setupEvents() {
        world.beforeEvents.itemUse.subscribe(event => {
            const player = event.source;
            if (!player) return;

            const item = event.itemStack;
            if (!item || item.typeId !== SELECTION_TOOL) return;

            event.cancel = true;

            const pos = Location.fromLocation(player.location);
            console.warn(`[Plot System] Player ${player.name} using golden axe at ${pos.toString()}`);

            if (!playerSelections.has(player.name)) {
                playerSelections.set(player.name, pos);
                console.warn(`[Plot System] Set first corner for ${player.name}`);
                player.sendMessage("§a[Plot System] First corner selected!");
            } else {
                const firstCorner = playerSelections.get(player.name);
                const boundary = new PlotBoundary(firstCorner, pos);

                console.warn(`[Plot System] Creating plot for ${player.name}: ${boundary.toString()}`);

                if (boundary.getVolume() > 32768) {
                    player.sendMessage("§c[Plot System] Plot is too large!");
                } else {
                    const plot = this.createPlot(boundary);
                    if (plot) {
                        player.sendMessage("§a[Plot System] Plot created successfully!");
                        // Verify plot was created correctly
                        const verifyPlot = this.getPlotAt(pos);
                        if (verifyPlot) {
                            console.warn(`[Plot System] Plot verified at location`);
                        } else {
                            console.warn(`[Plot System] Failed to verify plot!`);
                        }
                    } else {
                        player.sendMessage("§c[Plot System] Plot overlaps with existing plot!");
                    }
                }
                playerSelections.delete(player.name);
            }
        });

        world.beforeEvents.playerBreakBlock.subscribe(event => {
            const plot = this.getPlotAt(event.block.location);
            if (plot && plot.owner !== event.player.name) {
                event.cancel = true;
                event.player.sendMessage("§c[Plot System] You don't have permission to modify this plot!");
            }
        });

        world.beforeEvents.playerPlaceBlock.subscribe(event => {
            const plot = this.getPlotAt(event.block.location);
            if (plot && plot.owner !== event.player.name) {
                event.cancel = true;
                event.player.sendMessage("§c[Plot System] You don't have permission to modify this plot!");
            }
        });

        world.beforeEvents.chatSend.subscribe(event => {
            if (!event.message.startsWith(COMMAND_PREFIX)) return;

            event.cancel = true;
            const args = event.message.slice(1).trim().split(/\s+/);
            const command = args[0].toLowerCase();
            const player = event.sender;

            switch (command) {
                case 'claim':
                    this.handleClaimCommand(player);
                    break;
                case 'unclaim':
                    this.handleUnclaimCommand(player);
                    break;
                case 'info':
                    this.handleInfoCommand(player);
                    break;
                case 'help':
                    this.handleHelpCommand(player);
                    break;
            }
        });

        system.runInterval(() => {
            this.savePlots();
        }, 6000);
    }

    handleClaimCommand(player) {
        const plot = this.getPlotAt(player.location);
        console.warn(`[Plot System] Claim attempt by ${player.name} at ${Location.fromLocation(player.location).toString()}`);

        if (!plot) {
            player.sendMessage("§c[Plot System] You are not standing in a plot!");
            return;
        }

        if (plot.owner) {
            player.sendMessage(`§c[Plot System] This plot is already owned by ${plot.owner}`);
            return;
        }

        plot.owner = player.name;
        this.savePlots();
        player.sendMessage("§a[Plot System] Plot claimed successfully!");
    }

    handleUnclaimCommand(player) {
        const plot = this.getPlotAt(player.location);
        if (!plot) {
            player.sendMessage("§c[Plot System] You are not standing in a plot!");
            return;
        }

        if (plot.owner !== player.name) {
            player.sendMessage("§c[Plot System] You don't own this plot!");
            return;
        }

        plot.owner = "";
        this.savePlots();
        player.sendMessage("§a[Plot System] Plot unclaimed successfully!");
    }

    handleInfoCommand(player) {
        const plot = this.getPlotAt(player.location);
        if (!plot) {
            player.sendMessage("§c[Plot System] You are not standing in a plot!");
            return;
        }

        const size = plot.boundary.getVolume();

        player.sendMessage([
            "§e=== Plot Information ===",
            `§fOwner: ${plot.owner || "None"}`,
            `§fSize: ${size} blocks`,
            `§fBoundary: ${plot.boundary.toString()}`,
            `§fCreated: ${new Date(plot.created).toLocaleString()}`
        ].join("\n"));
    }

    handleHelpCommand(player) {
        player.sendMessage([
            "§e=== Plot System Commands ===",
            "§fUse Golden Axe to select plot corners",
            "§f!claim - Claim the plot you're standing in",
            "§f!unclaim - Unclaim your plot",
            "§f!info - View plot information",
            "§f!help - Show this help message"
        ].join("\n"));
    }
}

// Initialize the plot system
const plotSystem = new PlotSystem();
