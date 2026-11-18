"""Install English-to-target models used for movie summaries."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from shutil import copyfileobj
from tempfile import TemporaryFile
from urllib.request import urlopen
from zipfile import ZipFile
import argparse


MODEL_VERSIONS = {
    'es': '1_0', 'fr': '1_9', 'de': '1_3', 'pt': '1_9',
    'ru': '1_9', 'ar': '1_0', 'zh': '1_9', 'hi': '1_1',
}
LANGUAGES = ['tr', *MODEL_VERSIONS]
MODELS_DIR = Path(__file__).resolve().parents[1] / 'data' / 'translation'


def install_turkish_model():
    destination = MODELS_DIR / 'tr-hplt'
    ready = destination / '.ready'
    if ready.is_file():
        return 'tr: already installed'
    destination.mkdir(parents=True, exist_ok=True)
    revision = 'a0af93d1fcaff785fb01b86e3ff1cf3fe0a7dbf9'
    url = f'https://huggingface.co/WindyTranslate/translate-windy-hplt-en-tr/resolve/{revision}/'
    files = ('config.json', 'shared_vocabulary.json', 'model.bin', 'source.spm', 'target.spm', 'NOTICE.md', 'LICENSE')
    for name in files:
        with urlopen(url + name, timeout=45) as response, (destination / name).open('wb') as target:
            copyfileobj(response, target)
    ready.touch()
    return 'tr: installed'


def install_model(language):
    if language == 'tr':
        return install_turkish_model()
    destination = MODELS_DIR / language
    ready = destination / '.ready'
    if ready.is_file():
        return f'{language}: already installed'

    version = MODEL_VERSIONS[language]
    url = f'https://data.argosopentech.com/argospm/v1/translate-en_{language}-{version}.argosmodel'
    with TemporaryFile(dir=MODELS_DIR) as download:
        with urlopen(url, timeout=45) as response:
            copyfileobj(response, download)
        download.seek(0)
        with ZipFile(download) as package:
            # Only the model and tokenizer are needed. Derive the archive's top directory.
            tokenizer = next(name for name in package.namelist() if name.endswith('/sentencepiece.model'))
            root = tokenizer.rsplit('/', 1)[0]
            names = ('sentencepiece.model', 'metadata.json', 'model/model.bin', 'model/config.json',
                     'model/shared_vocabulary.json', 'model/source_vocabulary.json', 'model/target_vocabulary.json',
                     'model/shared_vocabulary.txt', 'model/source_vocabulary.txt', 'model/target_vocabulary.txt')
            (destination / 'model').mkdir(parents=True, exist_ok=True)
            for name in names:
                member = f'{root}/{name}'
                if member in package.namelist():
                    with package.open(member) as source, (destination / name).open('wb') as target:
                        copyfileobj(source, target)
            if not (destination / 'model' / 'model.bin').is_file():
                raise RuntimeError(f'No model weights for {language}')
    ready.touch()
    return f'{language}: installed'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('languages', nargs='*', default=LANGUAGES)
    args = parser.parse_args()
    if not set(args.languages).issubset(LANGUAGES):
        parser.error(f'Supported models: {", ".join(LANGUAGES)}')
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as executor:
        for result in executor.map(install_model, dict.fromkeys(args.languages)):
            print(result, flush=True)
