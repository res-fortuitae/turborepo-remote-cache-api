const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit millisecond time then 80 random bits, Crockford base32. */
export const ulid = (millis: number): string => {
  let time = "";

  for (let rest = millis, index = 0; index < 10; index++, rest = Math.floor(rest / 32))
    time = ALPHABET[rest % 32] + time;

  const random = crypto.getRandomValues(new Uint8Array(16));

  return time + Array.from(random, (byte) => ALPHABET[byte % 32]).join("");
};
