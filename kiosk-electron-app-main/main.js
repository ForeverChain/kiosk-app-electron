const { Worker, isMainThread, workerData, parentPort } = require("worker_threads");
const { SerialPort } = require("serialport");
const ffi = require("ffi-napi");
const axios = require("axios");
const https = require("https");
const path = require("path");

// Configure logging before any log calls
if (isMainThread) {
    const log = require("electron-log");
    // Use custom log directory instead of default Electron userData
    const customLogDir = path.join(require('os').homedir(), 'AppData', 'Roaming', 'kiosk-eletron-app', 'logs');
    
    // Ensure the custom log directory exists
    if (!require('fs').existsSync(customLogDir)) {
        require('fs').mkdirSync(customLogDir, { recursive: true });
    }
    
    // Set the log directory and filename separately
    log.transports.file.resolvePathFn = () => path.join(customLogDir, "main.log");
    log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB
    log.transports.file.retainDays = 7;
    console.log("Main thread log file path:", path.join(customLogDir, "main.log"));
}


// --- Process card data ---
const processBuffer = (buffer) => {
    const startIndex = buffer.indexOf(0x02);
    const endIndex = buffer.indexOf(0x03);
    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        let cardData = buffer.slice(startIndex + 2, endIndex);
        cardData = cardData.filter((byte) => byte !== 82 && byte !== 95);
        let cardNumber = String.fromCharCode(...cardData);
        if (cardNumber.length > 8) cardNumber = cardNumber.substr(0, 8);
        return cardNumber;
    }
    return "";
};

if (isMainThread) {
    const { app, BrowserWindow } = require("electron");
    const log = require("electron-log");
    log.info("✅ Main process log initialized");
    
    // Prevent multiple instances
    const gotTheLock = app.requestSingleInstanceLock();
    
    if (!gotTheLock) {
        log.info("❌ Another instance is already running. Exiting...");
        app.quit();
        return;
    }
    
    function createWindow() {
        const kioskId = process.env.KIOSK_ID;
        const kioskMode = process.env.KIOSK_APP_MODE;

        const mainWindow = new BrowserWindow({
            width: 1080,
            height: 1920,
            fullscreen: true,
            autoHideMenuBar: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true },
        });

        mainWindow.webContents.session.clearCache().then(() => {
            log.info("✅ Cache cleared successfully.");
        });

        mainWindow.loadURL(`https://next-app.xi.co.kr/kiosk/login`);

        // --- Banner handling ---
        let bannerShown = false;
        function showBanner(message) {
            if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return;
            if (bannerShown) return;

            bannerShown = true;
            const safeMessage = message.replace(/`/g, "\\`");

            mainWindow.webContents
                .executeJavaScript(
                    `
        var banner = document.getElementById('kiosk-alert');
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'kiosk-alert';
          banner.style.position = 'fixed';
          banner.style.top = '0';
          banner.style.left = '0';
          banner.style.width = '100%';
          banner.style.background = 'red';
          banner.style.color = 'white';
          banner.style.fontSize = '20px';
          banner.style.textAlign = 'center';
          banner.style.padding = '10px';
          banner.style.zIndex = '9999';
          document.body.appendChild(banner);
        }
        banner.innerText = \`${safeMessage}\`;
      `
                )
                .catch((err) => {
                    log.error("Failed to show banner:", err.message);
                    bannerShown = false;
                });
        }

        function hideBanner() {
            if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return;
            if (!bannerShown) return;

            mainWindow.webContents
                .executeJavaScript(
                    `
        var banner = document.getElementById('kiosk-alert');
        if (banner) banner.remove();
      `
                )
                .catch((err) => log.warn("Failed to hide banner:", err.message));

            bannerShown = false;
        }

        // --- Serial port with auto-retry ---
        let serialport;
        let buffer = [];
        let lastCardNumber = null;
        let retryCount = 0;
        const MAX_RETRY = 500;

        function openSerialPort() {
            serialport = new SerialPort({
                path: "COM5",
                baudRate: 4800,
                dataBits: 8,
                stopBits: 1,
                parity: "odd",
                bufferSize: 255,
                autoOpen: false,
            });

            serialport.open(async (err) => {
                if (err) {
                    log.error(`❌ Failed to open COM5: ${err.message}`);
                    showBanner(`❌ 포트 오류: COM5에 연결할 수 없습니다. USB 케이블 및 포트 연결을 확인해 주세요.`);
                    retryOpen();
                } else {
                    log.info("✅ Serial port is open!");
                    hideBanner();
                    retryCount = 0;
                }
            });

            serialport.on("data", async (data) => {
                buffer = [...buffer, ...data];
                const token = await mainWindow.webContents.executeJavaScript(`sessionStorage.getItem("token");`).catch(() => null);

                if (buffer.length === 12) {
                    const cardNumber = processBuffer(buffer);
                    const isSameCard = cardNumber === lastCardNumber;
                    const hasToken = !!token;

                    if (!isSameCard || !hasToken) {
                        lastCardNumber = cardNumber;
                        mainWindow.loadURL(`https://next-app.xi.co.kr/kiosk/login?rfCardNo=${cardNumber}&kioskId=${kioskId}`);
                    }

                    buffer = [];
                }
            });

            serialport.on("close", () => {
                log.warn("⚠️ Serial port closed. Retrying...");
                showBanner("❌ 포트 오류: COM5에 연결할 수 없습니다. USB 케이블 및 포트 연결을 확인해 주세요.");
                retryOpen();
            });

            serialport.on("error", (err) => {
                log.error("❌ Serial port error:", err.message);
                showBanner(`❌ 포트 오류: COM5에 연결할 수 없습니다. USB 케이블 및 포트 연결을 확인해 주세요.`);
                if (!serialport.isOpen) retryOpen();
            });
        }

        function retryOpen() {
            if (retryCount >= MAX_RETRY) {
                log.error(`❌ Max retries reached (${MAX_RETRY}). Stop retrying.`);
                showBanner(`❌ 포트 오류: COM5에 연결할 수 없습니다. USB 케이블 및 포트 연결을 확인해 주세요.`);
                return;
            }
            retryCount++;
            setTimeout(() => {
                log.info(`🔄 Retrying to open COM5... (Attempt ${retryCount})`);
                openSerialPort();
            }, 5000);
        }

        openSerialPort();

        // --- Printer worker ---
        try {
            const printerWorker = new Worker(__filename, {
                workerData: { kioskId, kioskMode },
            });

            // Worker logs are now handled directly by electron-log

            printerWorker.on("error", (err) => log.error("❌ Worker error:", err));
            printerWorker.on("exit", (code) => log.info("ℹ️ Worker exited with code:", code));
        } catch (err) {
            log.error("❌ Failed to start worker:", err);
        }

        app.setLoginItemSettings({ openAtLogin: true, path: app.getPath("exe") });
    }

    app.whenReady().then(() => {
  
        createWindow();
    });
} else {
    // --- Worker thread: printer + heartbeat ---
    console.log("Worker thread started");
    
    const { kioskId, kioskMode } = workerData;
    console.log("Worker data:", { kioskId, kioskMode });
    
    const fs = require('fs');
    const os = require('os');

    // Simple file logging for worker thread - use same path as main thread
    const logDir = path.join(os.homedir(), 'AppData', 'Roaming', 'kiosk-eletron-app', 'logs');
    const logFile = path.join(logDir, 'main.log');
    
    console.log("Log directory:", logDir);
    console.log("Log file:", logFile);
    
    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
        console.log("Creating log directory");
        fs.mkdirSync(logDir, { recursive: true });
    }
    
    function workerLog(level, message) {
        console.log("workerLog called with:", level, message);
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level}] ${message}\n`;
        
        try {
            console.log("Writing to log file:", logFile);
            console.log("Log entry:", logEntry);
            fs.appendFileSync(logFile, logEntry);
            console.log("Successfully wrote to log file");
        } catch (error) {
            console.error("Error writing to log file:", error);
        }
    }
    
    console.log("About to call workerLog");
    workerLog("info", "Worker started successfully ✅");
    console.log("Called workerLog");

    const bixolonSDK = ffi.Library(
        kioskMode === "DEV" ? "C:\\BIXOLON\\BXLPAPI.dll" : process.resourcesPath + "\\BXLPAPI.dll",
        {
            PrinterOpen: ["int", ["int", "string", "int", "int", "int", "int", "int"]],
            GetPrinterCurrentStatus: ["int", []],
            PrinterClose: ["int", []],
        }
    );

    let errorCount = 0;
    let zeroCount = 0;
    let lastStatus = null;

    async function sendKioskHeartbeat() {
        try {
            await axios.post(
                "https://next.xi.co.kr/api/v2/fmcs/kiosk/update/time",
                { kioskId, kioskStatus: 1 },
                { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
            );
            workerLog("info", "✅ Kiosk heartbeat sent");
        } catch (e) {
            workerLog("error", `Send kiosk heartbeat error: ${e.message}`);
        }
    }

    async function sendPrinterStatus(status) {
        try {
            await axios.post(
                "https://next.xi.co.kr/api/v2/fmcs/kiosk/update/time",
                { kioskId, kioskStatus: 1, printerStatus: status },
                { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
            );
            workerLog("info", `✅ Printer status sent: ${status}`);
        } catch (e) {
            workerLog("error", `Send printer status error: ${e.message}`);
        }
    }

    async function printerLoop() {
        try {
            bixolonSDK.PrinterClose();
            bixolonSDK.PrinterOpen(2, "", 0, 0, 0, 0, 0);
            const status = bixolonSDK.GetPrinterCurrentStatus();
            bixolonSDK.PrinterClose();

            if (status === -101) {
                errorCount++;
                zeroCount = 0;
                if (errorCount >= 5) {
                    await sendPrinterStatus(status);
                    errorCount = 0;
                }
            } else if (status === 0) {
                zeroCount++;
                errorCount = 0;
                if (status !== lastStatus || zeroCount <= 5) await sendPrinterStatus(status);
            } else {
                errorCount = 0;
                zeroCount = 0;
                if (status !== lastStatus) await sendPrinterStatus(status);
            }

            lastStatus = status;
        } catch (err) {
            workerLog("error", `Printer loop error: ${err.message}`);
        } finally {
            setTimeout(printerLoop, 3000);
        }
    }

    async function kioskStatusLoop() {
        try {
            await sendKioskHeartbeat();
        } catch (err) {
            workerLog("error", `Kiosk status loop error: ${err.message}`);
        } finally {
            setTimeout(kioskStatusLoop, 10000);
        }
    }

    workerLog("info", "Worker started successfully ✅");
    printerLoop();
    kioskStatusLoop();
}
