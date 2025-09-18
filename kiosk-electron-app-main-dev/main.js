const { app, BrowserWindow } = require("electron");
const { Worker, isMainThread, workerData } = require("worker_threads");
const { SerialPort } = require("serialport");
const ffi = require("ffi-napi");
const axios = require("axios");
const https = require("https");
const log = require("electron-log");

const processBuffer = (buffer) => {
    let startIndex = buffer.indexOf(0x02);
    let endIndex = buffer.indexOf(0x03);
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
    let mainWindow;

    function createWindow() {
        const kioskId = process.env.KIOSK_ID;
        const kioskMode = process.env.KIOSK_APP_MODE;

        mainWindow = new BrowserWindow({
            width: 1080,
            height: 1920,
            fullscreen: true,
            autoHideMenuBar: true,
        });

        mainWindow.webContents.session.clearCache().then(() => {
            log.info("✅ Cache cleared successfully.");
        });

        mainWindow.loadURL(`http://139.150.71.249:5178/kiosk/login`);

        // ---------- Serial Port with Auto-Retry ----------
        let serialport;
        let buffer = [];
        let lastCardNumber = null;
        let retryCount = 0;
        const MAX_RETRY = 500;
        let bannerShown = false;

        function showBanner(message) {
            if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return;
            if (bannerShown) return; // only show once

            bannerShown = true;
            const safeMessage = message.replace(/`/g, "\\`"); // escape backticks

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
                    bannerShown = false; // allow retry next time
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

            serialport.open((err) => {
                if (err) {
                    log.error("❌ Failed to open COM5:", err.message);
                    if (!bannerShown) showBanner(`❌ 포트 오류: COM5에 연결할 수 없습니다. USB 케이블 및 포트 연결을 확인해 주세요.`);
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

                log.info("buffer", buffer);

                if (buffer.length === 12) {
                    const cardNumber = processBuffer(buffer);
                    const isSameCard = cardNumber === lastCardNumber;
                    const hasToken = !!token;

                    if (!isSameCard || !hasToken) {
                        lastCardNumber = cardNumber;
                        mainWindow.loadURL(`http://139.150.71.249:5178/kiosk/login?rfCardNo=${cardNumber}&kioskId=${kioskId}`);
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
                showBanner(`❌ Serial port COM5 failed to open after ${MAX_RETRY} attempts.`);
                return;
            }
            retryCount++;
            setTimeout(() => {
                log.info(`🔄 Retrying to open COM5... (Attempt ${retryCount})`);
                openSerialPort();
            }, 5000);
        }

        openSerialPort();

        // ---------- Printer Worker ----------
        try {
            const printerWorker = new Worker(__filename, {
                workerData: { kioskId, kioskMode },
            });

            printerWorker.on("error", (err) => {
                log.error("❌ Worker error:", err);
                showBanner(`❌ Printer worker error: ${err.message}`);
            });

            printerWorker.on("exit", (code) => {
                log.info("ℹ️ Worker exited with code:", code);
            });
        } catch (err) {
            log.error("❌ Failed to start worker:", err);
            showBanner(`❌ Failed to start printer worker: ${err.message}`);
        }

        app.setLoginItemSettings({
            openAtLogin: true,
            path: app.getPath("exe"),
        });
    }

    app.whenReady().then(createWindow);
} else {
    const { kioskId, kioskMode } = workerData;

    const bixolonSDK = ffi.Library(kioskMode === "DEV" ? "C:\\BIXOLON\\BXLPAPI.dll" : process.resourcesPath + "\\BXLPAPI.dll", {
        PrinterOpen: ["int", ["int", "string", "int", "int", "int", "int", "int"]],
        GetPrinterCurrentStatus: ["int", []],
        PrinterClose: ["int", []],
    });

    let errorCount = 0;
    let zeroCount = 0;
    let lastStatus = null;

    async function sendKioskHeartbeat() {
        try {
            await axios.post("http://139.150.71.249:5178/api/v1/fmcs/kiosk/update/time", { kioskId, kioskStatus: 1 }, { httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
        } catch (e) {
            log.error("Send kiosk heartbeat error:", e.message);
        }
    }

    async function sendPrinterStatus(status) {
        try {
            return await axios.post("http://139.150.71.249:5178/api/v1/fmcs/kiosk/update/time", { kioskId, kioskStatus: 1, printerStatus: status }, { httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
        } catch (e) {
            log.error("Send printer status error:", e.message);
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
                if (status !== lastStatus || zeroCount <= 5) {
                    if (zeroCount <= 5) await sendPrinterStatus(status);
                }
            } else {
                errorCount = 0;
                zeroCount = 0;
                if (status !== lastStatus) await sendPrinterStatus(status);
            }

            lastStatus = status;
        } catch (err) {
            log.error("Printer loop error:", err.message);
        } finally {
            setTimeout(printerLoop, 3000);
        }
    }

    async function kioskStatusLoop() {
        try {
            await sendKioskHeartbeat();
        } catch (err) {
            log.error("Kiosk status loop error:", err.message);
        } finally {
            setTimeout(kioskStatusLoop, 10000);
        }
    }

    printerLoop();
    kioskStatusLoop();
}
