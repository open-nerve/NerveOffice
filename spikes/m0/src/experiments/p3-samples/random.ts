// 确定性随机数：样本可以按同样的种子重新生成。

/** mulberry32：32 位状态的伪随机数发生器，返回 [0, 1)。 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function pick<T>(list: readonly T[], rand: () => number): T {
    return list[Math.floor(rand() * list.length)];
}

/** 常用汉字，用于生成中文正文。 */
export const HANZI = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处府';

export function hanziText(length: number, rand: () => number): string {
    let s = '';
    for (let i = 0; i < length; i++) s += HANZI[Math.floor(rand() * HANZI.length)];
    return s;
}
