import CryptoKit
import Foundation
import Security

/// Порт `core/crypto/SecretCrypto.kt` — байт-в-байт совместимая криптография секреток
/// (веб: tweetnacl + @noble/hashes; Android: libsodium):
///  - X25519-пары (nacl.box.keyPair) и ECDH (nacl.scalarMult) — через CryptoKit Curve25519;
///  - HKDF-SHA256 для вывода сессионных ключей (RFC 5869);
///  - XSalsa20-Poly1305 (nacl.secretbox) — в CryptoKit её НЕТ (только ChaChaPoly, это
///    ДРУГОЙ шифр), поэтому HSalsa20/Salsa20/Poly1305 реализованы вручную по референсу
///    NaCl (poly1305 — схема donna-32) и сверены с каноническим вектором secretbox;
///  - URL-safe base64 без паддинга (bytesToBase64 веба).
///
/// Раскладка secretbox — как у crypto_secretbox_easy/nacl.secretbox:
/// `[16 байт Poly1305-тега || шифртекст]`; nonce 24 байта, ключ 32 байта. Шифртексты
/// взаимозаменяемы между вебом, Android и iOS.
enum SecretCrypto {
    static let keyBytes = 32
    static let nonceBytes = 24
    private static let macBytes = 16

    struct KeyPair {
        let publicKey: Data
        let secretKey: Data
    }

    /// nacl.box.keyPair: секрет — сырые 32 байта, клэмпинг X25519 происходит при
    /// использовании (CryptoKit хранит rawRepresentation так же).
    static func generateKeyPair() -> KeyPair {
        let sk = Curve25519.KeyAgreement.PrivateKey()
        return KeyPair(publicKey: sk.publicKey.rawRepresentation, secretKey: sk.rawRepresentation)
    }

    /// X25519 ECDH: scalarMult(secret, peerPublic) → 32 байта общего секрета (== nacl.scalarMult).
    /// nil — битый вход (не 32 байта) или нулевой результат: nacl молча вернул бы нули на
    /// low-order точке, CryptoKit отказывает — это безопаснее, а честные клиенты таких ключей
    /// не шлют.
    static func scalarMult(secret: Data, peerPublic: Data) -> Data? {
        guard let sk = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret),
              let pk = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublic),
              let shared = try? sk.sharedSecretFromKeyAgreement(with: pk) else { return nil }
        return shared.withUnsafeBytes { Data($0) }
    }

    static func randomBytes(_ n: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: n)
        let status = SecRandomCopyBytes(kSecRandomDefault, n, &bytes)
        // Провал системного CSPRNG — не то место, где можно «деградировать» тихо.
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
        return Data(bytes)
    }

    static func randomKey() -> Data { randomBytes(keyBytes) }
    static func randomNonce() -> Data { randomBytes(nonceBytes) }

    // MARK: - nacl.secretbox (XSalsa20-Poly1305)

    /// nacl.secretbox: возвращает [16-байтовый тег || шифртекст].
    static func secretBox(message: Data, nonce: Data, key: Data) -> Data {
        precondition(nonce.count == nonceBytes && key.count == keyBytes, "secretbox: bad nonce/key")
        let m = [UInt8](message)
        let n = [UInt8](nonce)
        let subkey = hsalsa20(key: [UInt8](key), input16: Array(n[0..<16]))
        // Один keystream на всё: первые 32 байта — одноразовый ключ Poly1305 (конструкция
        // crypto_secretbox: сообщение как бы дополнено 32 нулями спереди).
        let ks = salsa20KeyStream(subkey: subkey, nonce8: Array(n[16..<24]), count: 32 + m.count)
        var ct = [UInt8](repeating: 0, count: m.count)
        for i in 0..<m.count { ct[i] = m[i] ^ ks[32 + i] }
        let tag = poly1305(ct[...], key: Array(ks[0..<32]))
        var out = Data(capacity: macBytes + ct.count)
        out.append(contentsOf: tag)
        out.append(contentsOf: ct)
        return out
    }

    /// nacl.secretbox.open: plaintext либо nil при провале аутентификации/битом входе.
    static func secretBoxOpen(cipher: Data, nonce: Data, key: Data) -> Data? {
        // Враждебный дескриптор может принести короткие массивы — как и в Kotlin-порте,
        // отвечаем аккуратным nil, а не чтением мимо буфера.
        guard nonce.count == nonceBytes, key.count == keyBytes, cipher.count >= macBytes else {
            return nil
        }
        let c = [UInt8](cipher)
        let n = [UInt8](nonce)
        let subkey = hsalsa20(key: [UInt8](key), input16: Array(n[0..<16]))
        let ctLen = c.count - macBytes
        let ks = salsa20KeyStream(subkey: subkey, nonce8: Array(n[16..<24]), count: 32 + ctLen)
        let tag = poly1305(c[macBytes...], key: Array(ks[0..<32]))
        // Сравнение тега в постоянное время — иначе оракул подделки по таймингу.
        var diff: UInt8 = 0
        for i in 0..<macBytes { diff |= tag[i] ^ c[i] }
        guard diff == 0 else { return nil }
        var m = [UInt8](repeating: 0, count: ctLen)
        for i in 0..<ctLen { m[i] = c[macBytes + i] ^ ks[32 + i] }
        return Data(m)
    }

    // MARK: - HKDF-SHA256

    /// RFC 5869 (совпадает с @noble/hashes hkdf(sha256, ikm, salt, info, length)).
    /// Развёрнут вручную 1:1 с Kotlin-портом; пустая соль → 32 нулевых байта (HMAC дополняет
    /// ключ нулями до блока, так что это эквивалентно пустому ключу — как у @noble).
    static func hkdfSha256(ikm: Data, salt: Data, info: Data, length: Int) -> Data {
        let saltKey = salt.isEmpty ? Data(repeating: 0, count: 32) : salt
        let prk = Data(HMAC<SHA256>.authenticationCode(for: ikm, using: SymmetricKey(data: saltKey))) // extract
        let prkKey = SymmetricKey(data: prk)
        var out = Data(capacity: length)
        var t = Data()
        var counter: UInt8 = 1
        while out.count < length { // expand
            var mac = HMAC<SHA256>(key: prkKey)
            mac.update(data: t)
            mac.update(data: info)
            mac.update(data: Data([counter]))
            t = Data(mac.finalize())
            out.append(t.prefix(length - out.count))
            counter &+= 1
        }
        return out
    }

    // MARK: - base64url

    static func b64UrlEncode(_ bytes: Data) -> String {
        bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// nil на мусорном входе (Kotlin кидал IllegalArgumentException — вызывающие и там
    /// оборачивали в runCatching, здесь проверяют optional).
    static func b64UrlDecode(_ s: String) -> Data? {
        var normalized = s.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        // Data(base64Encoded:) в отличие от Android требует паддинг — достраиваем.
        let rem = normalized.count % 4
        if rem > 0 { normalized += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: normalized)
    }

    // MARK: - Самопроверка интеропа

    /// Быстрая проверка совместимости: вектор X25519 из RFC 7748 + симметрия DH, вектор
    /// HKDF из RFC 5869, канонический вектор secretbox из NaCl (tests/secretbox.c) —
    /// он прогоняет HSalsa20+Salsa20+Poly1305 целиком — и round-trip на случайном ключе.
    static func selfTest() -> Bool {
        // X25519: RFC 7748 §6.1 (scalar Алисы × публичный Боба → известный общий секрет).
        guard
            let aliceSk = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"),
            let bobPk = fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"),
            let shared = scalarMult(secret: aliceSk, peerPublic: bobPk),
            shared == fromHex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
        else { return false }
        let a = generateKeyPair()
        let b = generateKeyPair()
        guard let sharedA = scalarMult(secret: a.secretKey, peerPublic: b.publicKey),
              let sharedB = scalarMult(secret: b.secretKey, peerPublic: a.publicKey),
              sharedA == sharedB else { return false }

        // HKDF: RFC 5869 Test Case 1.
        let ikm = Data(repeating: 0x0b, count: 22)
        let salt = Data((0..<13).map { UInt8($0) })
        let info = Data((0..<10).map { UInt8(0xf0 + $0) })
        let okm = hkdfSha256(ikm: ikm, salt: salt, info: info, length: 42)
        guard okm == fromHex(
            "3cb25f25faacd57a90434f64d0362f2a"
                + "2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
                + "34007208d5b887185865"
        ) else { return false }

        // secretbox: канонический вектор NaCl — ловит любую ошибку в ручной реализации.
        guard
            let key = fromHex("1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389"),
            let nonce = fromHex("69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37"),
            let msg = fromHex(
                "be075fc53c81f2d5cf141316ebeb0c7b5228c52a4c62cbd44b66849b64244ffc"
                    + "e5ecbaaf33bd751a1ac728d45e6c61296cdc3c01233561f41db66cce314adb31"
                    + "0e3be8250c46f06dceea3a7fa1348057e2f6556ad6b1318a024a838f21af1fde"
                    + "048977eb48f59ffd4924ca1c60902e52f0a089bc76897040e082f93776384864"
                    + "5e0705"
            ),
            let expected = fromHex(
                "f3ffc7703f9400e52a7dfb4b3d3305d98e993b9f48681273c29650ba32fc76ce"
                    + "48332ea7164d96a4476fb8c531a1186ac0dfc17c98dce87b4da7f011ec48c972"
                    + "71d2c20f9b928fe2270d6fb863d51738b48eeee314a7cc8ab932164548e526ae"
                    + "90224368517acfeabd6bb3732bc0e9da99832b61ca01b6de56244a9e88d5f9b3"
                    + "7973f622a43d14a6599b1f654cb45a74e355a5"
            ),
            secretBox(message: msg, nonce: nonce, key: key) == expected
        else { return false }

        let rk = randomKey()
        let rn = randomNonce()
        let rm = Data("Еблуша secret ✓".utf8)
        return secretBoxOpen(cipher: secretBox(message: rm, nonce: rn, key: rk), nonce: rn, key: rk) == rm
    }

    private static func fromHex(_ s: String) -> Data? {
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var index = s.startIndex
        while index < s.endIndex {
            let next = s.index(index, offsetBy: 2)
            guard let byte = UInt8(s[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        return out
    }

    // MARK: - Salsa20 / HSalsa20

    /// "expand 32-byte k".
    private static let sigma: [UInt32] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]

    private static func rotl(_ x: UInt32, _ n: UInt32) -> UInt32 {
        (x << n) | (x >> (32 - n))
    }

    /// 10 double-раундов Salsa20 (столбцы + строки) поверх 16-словного состояния.
    private static func doubleRounds(_ x: inout [UInt32]) {
        for _ in 0..<10 {
            x[4] ^= rotl(x[0] &+ x[12], 7); x[8] ^= rotl(x[4] &+ x[0], 9)
            x[12] ^= rotl(x[8] &+ x[4], 13); x[0] ^= rotl(x[12] &+ x[8], 18)
            x[9] ^= rotl(x[5] &+ x[1], 7); x[13] ^= rotl(x[9] &+ x[5], 9)
            x[1] ^= rotl(x[13] &+ x[9], 13); x[5] ^= rotl(x[1] &+ x[13], 18)
            x[14] ^= rotl(x[10] &+ x[6], 7); x[2] ^= rotl(x[14] &+ x[10], 9)
            x[6] ^= rotl(x[2] &+ x[14], 13); x[10] ^= rotl(x[6] &+ x[2], 18)
            x[3] ^= rotl(x[15] &+ x[11], 7); x[7] ^= rotl(x[3] &+ x[15], 9)
            x[11] ^= rotl(x[7] &+ x[3], 13); x[15] ^= rotl(x[11] &+ x[7], 18)
            x[1] ^= rotl(x[0] &+ x[3], 7); x[2] ^= rotl(x[1] &+ x[0], 9)
            x[3] ^= rotl(x[2] &+ x[1], 13); x[0] ^= rotl(x[3] &+ x[2], 18)
            x[6] ^= rotl(x[5] &+ x[4], 7); x[7] ^= rotl(x[6] &+ x[5], 9)
            x[4] ^= rotl(x[7] &+ x[6], 13); x[5] ^= rotl(x[4] &+ x[7], 18)
            x[11] ^= rotl(x[10] &+ x[9], 7); x[8] ^= rotl(x[11] &+ x[10], 9)
            x[9] ^= rotl(x[8] &+ x[11], 13); x[10] ^= rotl(x[9] &+ x[8], 18)
            x[12] ^= rotl(x[15] &+ x[14], 7); x[13] ^= rotl(x[12] &+ x[15], 9)
            x[14] ^= rotl(x[13] &+ x[12], 13); x[15] ^= rotl(x[14] &+ x[13], 18)
        }
    }

    /// crypto_core_hsalsa20: 20 раундов БЕЗ финального сложения, выход — слова
    /// 0,5,10,15,6,7,8,9. Превращает (ключ, первые 16 байт nonce) в подключ XSalsa20.
    private static func hsalsa20(key: [UInt8], input16: [UInt8]) -> [UInt8] {
        var x = [UInt32](repeating: 0, count: 16)
        x[0] = sigma[0]; x[5] = sigma[1]; x[10] = sigma[2]; x[15] = sigma[3]
        for i in 0..<4 {
            x[1 + i] = le32(key, 4 * i)
            x[11 + i] = le32(key, 16 + 4 * i)
            x[6 + i] = le32(input16, 4 * i)
        }
        doubleRounds(&x)
        var out = [UInt8](repeating: 0, count: 32)
        let picks = [0, 5, 10, 15, 6, 7, 8, 9]
        for (j, idx) in picks.enumerated() { store32(&out, 4 * j, x[idx]) }
        return out
    }

    /// crypto_stream_salsa20: keystream от (подключ, 8-байтовый nonce), счётчик с нуля.
    private static func salsa20KeyStream(subkey: [UInt8], nonce8: [UInt8], count: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: count)
        var counter: UInt64 = 0
        var offset = 0
        while offset < count {
            var x = [UInt32](repeating: 0, count: 16)
            x[0] = sigma[0]; x[5] = sigma[1]; x[10] = sigma[2]; x[15] = sigma[3]
            for i in 0..<4 {
                x[1 + i] = le32(subkey, 4 * i)
                x[11 + i] = le32(subkey, 16 + 4 * i)
            }
            x[6] = le32(nonce8, 0)
            x[7] = le32(nonce8, 4)
            x[8] = UInt32(truncatingIfNeeded: counter)
            x[9] = UInt32(truncatingIfNeeded: counter >> 32)
            let input = x
            doubleRounds(&x)
            var block = [UInt8](repeating: 0, count: 64)
            for i in 0..<16 { store32(&block, 4 * i, x[i] &+ input[i]) }
            let n = min(64, count - offset)
            out.replaceSubrange(offset..<offset + n, with: block[0..<n])
            offset += n
            counter &+= 1
        }
        return out
    }

    // MARK: - Poly1305 (donna-32: 26-битные конечности в UInt64)

    private static func poly1305(_ msg: ArraySlice<UInt8>, key: [UInt8]) -> [UInt8] {
        let m = Array(msg)
        // Клэмпинг r по спецификации.
        let r0 = UInt64(le32(key, 0) & 0x3ffffff)
        let r1 = UInt64((le32(key, 3) >> 2) & 0x3ffff03)
        let r2 = UInt64((le32(key, 6) >> 4) & 0x3ffc0ff)
        let r3 = UInt64((le32(key, 9) >> 6) & 0x3f03fff)
        let r4 = UInt64((le32(key, 12) >> 8) & 0x00fffff)
        let s1 = r1 &* 5, s2 = r2 &* 5, s3 = r3 &* 5, s4 = r4 &* 5

        var h0: UInt64 = 0, h1: UInt64 = 0, h2: UInt64 = 0, h3: UInt64 = 0, h4: UInt64 = 0

        var i = 0
        while i < m.count {
            let take = min(16, m.count - i)
            var block = [UInt8](repeating: 0, count: 16)
            for j in 0..<take { block[j] = m[i + j] }
            var hibit: UInt64 = 1 << 24
            if take < 16 { // последний неполный блок: паддинг 0x01 || 0…, без hibit
                block[take] = 1
                hibit = 0
            }
            h0 &+= UInt64(le32(block, 0) & 0x3ffffff)
            h1 &+= UInt64((le32(block, 3) >> 2) & 0x3ffffff)
            h2 &+= UInt64((le32(block, 6) >> 4) & 0x3ffffff)
            h3 &+= UInt64((le32(block, 9) >> 6) & 0x3ffffff)
            h4 &+= UInt64(le32(block, 12) >> 8) | hibit

            // h *= r (mod 2^130-5): произведения ≤ 2^58, в UInt64 не переполняются.
            var d0 = h0 &* r0 &+ h1 &* s4 &+ h2 &* s3 &+ h3 &* s2 &+ h4 &* s1
            var d1 = h0 &* r1 &+ h1 &* r0 &+ h2 &* s4 &+ h3 &* s3 &+ h4 &* s2
            var d2 = h0 &* r2 &+ h1 &* r1 &+ h2 &* r0 &+ h3 &* s4 &+ h4 &* s3
            var d3 = h0 &* r3 &+ h1 &* r2 &+ h2 &* r1 &+ h3 &* r0 &+ h4 &* s4
            var d4 = h0 &* r4 &+ h1 &* r3 &+ h2 &* r2 &+ h3 &* r1 &+ h4 &* r0

            var c = d0 >> 26; var t0 = d0 & 0x3ffffff
            d1 &+= c; c = d1 >> 26; let t1 = d1 & 0x3ffffff
            d2 &+= c; c = d2 >> 26; let t2 = d2 & 0x3ffffff
            d3 &+= c; c = d3 >> 26; let t3 = d3 & 0x3ffffff
            d4 &+= c; c = d4 >> 26; let t4 = d4 & 0x3ffffff
            t0 &+= c &* 5; c = t0 >> 26; h0 = t0 & 0x3ffffff
            h1 = t1 &+ c; h2 = t2; h3 = t3; h4 = t4
            i += 16
        }

        // Финальная нормализация h.
        var c = h1 >> 26; h1 &= 0x3ffffff
        h2 &+= c; c = h2 >> 26; h2 &= 0x3ffffff
        h3 &+= c; c = h3 >> 26; h3 &= 0x3ffffff
        h4 &+= c; c = h4 >> 26; h4 &= 0x3ffffff
        h0 &+= c &* 5; c = h0 >> 26; h0 &= 0x3ffffff
        h1 &+= c

        // Выбор h либо h+5-2^130 (редукция по модулю) в постоянное время.
        var g0 = h0 &+ 5; c = g0 >> 26; g0 &= 0x3ffffff
        var g1 = h1 &+ c; c = g1 >> 26; g1 &= 0x3ffffff
        var g2 = h2 &+ c; c = g2 >> 26; g2 &= 0x3ffffff
        var g3 = h3 &+ c; c = g3 >> 26; g3 &= 0x3ffffff
        let g4 = h4 &+ c &- (1 << 26) // при заёме уходит в «отрицательное» (бит 63)
        let mask: UInt64 = ((g4 >> 63) & 1) &- 1
        h0 = (h0 & ~mask) | (g0 & mask)
        h1 = (h1 & ~mask) | (g1 & mask)
        h2 = (h2 & ~mask) | (g2 & mask)
        h3 = (h3 & ~mask) | (g3 & mask)
        h4 = (h4 & ~mask) | (g4 & mask)

        // Упаковка в 128 бит и прибавление pad (key[16..32]) mod 2^128.
        let hh0 = (h0 | (h1 << 26)) & 0xffffffff
        let hh1 = ((h1 >> 6) | (h2 << 20)) & 0xffffffff
        let hh2 = ((h2 >> 12) | (h3 << 14)) & 0xffffffff
        let hh3 = ((h3 >> 18) | (h4 << 8)) & 0xffffffff

        var f = hh0 &+ UInt64(le32(key, 16)); let o0 = UInt32(truncatingIfNeeded: f)
        f = hh1 &+ UInt64(le32(key, 20)) &+ (f >> 32); let o1 = UInt32(truncatingIfNeeded: f)
        f = hh2 &+ UInt64(le32(key, 24)) &+ (f >> 32); let o2 = UInt32(truncatingIfNeeded: f)
        f = hh3 &+ UInt64(le32(key, 28)) &+ (f >> 32); let o3 = UInt32(truncatingIfNeeded: f)

        var tag = [UInt8](repeating: 0, count: 16)
        store32(&tag, 0, o0); store32(&tag, 4, o1); store32(&tag, 8, o2); store32(&tag, 12, o3)
        return tag
    }

    // MARK: - little-endian helpers

    private static func le32(_ b: [UInt8], _ i: Int) -> UInt32 {
        UInt32(b[i]) | (UInt32(b[i + 1]) << 8) | (UInt32(b[i + 2]) << 16) | (UInt32(b[i + 3]) << 24)
    }

    private static func store32(_ b: inout [UInt8], _ i: Int, _ v: UInt32) {
        b[i] = UInt8(truncatingIfNeeded: v)
        b[i + 1] = UInt8(truncatingIfNeeded: v >> 8)
        b[i + 2] = UInt8(truncatingIfNeeded: v >> 16)
        b[i + 3] = UInt8(truncatingIfNeeded: v >> 24)
    }
}
