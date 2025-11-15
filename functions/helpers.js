// --- FUNGSI HELPER (DIPINDAH) ---

function strToBuf(str) { return new TextEncoder().encode(str); }
function bufToHex(buffer) { return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join(''); }

// FUNGSI CRC16-CCITT (Poly: 0x1021, Init: 0xFFFF)
export function crc16_ccitt_js(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        let byte = data.charCodeAt(i);
        let x = ((crc >> 8) ^ byte) & 0xFF;
        x ^= x >> 4;
        crc = ((crc << 8) ^ (x << 12) ^ (x << 5) ^ x) & 0xFFFF;
    }
    return crc;
}

// Mem-parsing string TLV (Tag-Length-Value)
export function parseTlv_js(tlv) {
    const tags = {};
    let i = 0;
    while (i < tlv.length) {
        const tag = tlv.substring(i, i + 2);
        const lengthStr = tlv.substring(i + 2, i + 4);
        const length = parseInt(lengthStr, 10);
        const value = tlv.substring(i + 4, i + 4 + length);
        tags[tag] = value;
        i += 4 + length;
    }
    return tags;
}

// Fungsi utama: Menyuntikkan nominal ke QRIS
export function injectAmountIntoQris(qrisRaw, amount) {
    if (!qrisRaw || typeof qrisRaw !== 'string') return null;
    try {
        const tags = parseTlv_js(qrisRaw);
        delete tags['63'];
        tags['53'] = '360'; // IDR
        tags['54'] = amount.toFixed(2);
        tags['58'] = 'ID';
        const sortedKeys = Object.keys(tags).sort();
        let newTlvString = '';
        for (const tag of sortedKeys) {
            const value = tags[tag];
            const lengthStr = String(value.length).padStart(2, '0');
            newTlvString += tag + lengthStr + value;
        }
        const stringToCrc = newTlvString + '6304';
        const crc = crc16_ccitt_js(stringToCrc);
        const crcHex = crc.toString(16).toUpperCase().padStart(4, '0');
        return stringToCrc + crcHex;
    } catch (e) {
        console.error("Gagal inject QRIS:", e.message);
        return null;
    }
}

export async function hashPassword(password, secret) {
  const data = strToBuf(password + secret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(hashBuffer);
}

export function calculateTransactionDetails(baseAmount) {
    const amount = parseInt(baseAmount, 10);
    const uniqueCode = Math.floor(Math.random() * 999) + 1; 
    const totalAmount = amount + uniqueCode;
    return { uniqueCode: uniqueCode, totalAmount: totalAmount, baseAmount: amount };
}

export function parseAmountFromText(text) {
    if (!text) return null;
    const regex = /(?:Rp|IDR|sebesar)\s*([\d\.,]+)/i;
    const match = text.match(regex);
    if (match && match[1]) {
        const cleanNumber = match[1].replace(/\./g, '').replace(/,.*$/, '');
        const amount = parseInt(cleanNumber, 10);
        return isNaN(amount) ? null : amount;
    }
    return null;
}

export function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-');
}
