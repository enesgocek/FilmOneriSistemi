"""Reject placeholders and clear review language in catalogue plot text."""

import html
import re
import unicodedata


_PLACEHOLDERS = {
    'unknown', 'none', 'nan', 'n/a', 'no overview', 'no overview available',
    'no synopsis available', 'no description available', 'ozet bulunamadi',
    'bu film icin ozet bulunamadi',
}
_REVIEW_PHRASES = re.compile(
    r'\b(?:filmi (?:cok |gercekten )?begendim|filmi (?:begenmedim|tavsiye ederim)|'
    r'kesinlikle tavsiye ediyorum|kesinlikle tavsiye ederim|kendi adima soylemek gerekirse|'
    r'(?:i|we) (?:really |absolutely )?(?:enjoyed|loved|hated|recommend) (?:this|the) (?:movie|film)|'
    r'i would (?:definitely )?recommend (?:this|the) (?:movie|film)|'
    r'i give (?:this|the) (?:movie|film) (?:a |an )?\d|my review of (?:this|the) (?:movie|film)|'
    r'me (?:encanto|gusto mucho) (?:esta|la) pelicula|j.ai (?:adore|beaucoup aime) ce film|'
    r'ich (?:liebe|empfehle) diesen film|eu (?:adorei|recomendo) (?:este|esse) filme)\b'
)


def clean_synopsis(value: object) -> str:
    if not isinstance(value, str):
        return ''

    text = html.unescape(value)
    text = re.sub(r'</?(?:p|br|i|em|b|strong)\s*/?>', ' ', text, flags=re.IGNORECASE)
    text = ' '.join(unicodedata.normalize('NFKC', text).split())
    if not 20 <= len(text) <= 5000:
        return ''

    folded = unicodedata.normalize('NFKD', text.casefold().replace('ı', 'i'))
    folded = ''.join(char for char in folded if not unicodedata.combining(char))
    if folded.strip(' .!…-') in _PLACEHOLDERS or _REVIEW_PHRASES.search(folded):
        return ''
    return text
