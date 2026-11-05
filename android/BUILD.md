# Rastro para Android (APK)

Wrapper WebView de la app web online (https://xesco-tejedor.github.io/Rastro/).
Misma busqueda y lista/exportacion de referencias; la lista se guarda en el
dispositivo (localStorage del WebView). Unico permiso: INTERNET. minSdk 29
(Android 10+), targetSdk 34. Los enlaces a tiendas y fichas se abren en el
navegador del sistema; las exportaciones (.txt/.html) se guardan en Descargas
via MediaStore, con el puente JS limitado al origen de la app y nombre/tipo/
tamano validados.

## Estado

Experimental: compilada y verificada estaticamente (firma, permisos), NO
probada en un dispositivo o emulador Android.

## Toolchain (sin Android Studio ni Gradle)

- JDK 17 (Temurin)
- Android SDK command line tools + `platforms;android-34` + `build-tools;34.0.0`

## Pasos

    python3 gen_icons.py
    BT=$SDK/build-tools/34.0.0
    $BT/aapt2 compile --dir app/res -o compiled.zip
    $BT/aapt2 link -o base.apk -I $SDK/platforms/android-34/android.jar \
        --manifest app/AndroidManifest.xml --java gen compiled.zip
    javac --release 8 -cp $SDK/platforms/android-34/android.jar -d obj \
        gen/com/xescotejedor/rastro/R.java \
        app/src/com/xescotejedor/rastro/MainActivity.java
    $BT/d8 --min-api 29 --lib $SDK/platforms/android-34/android.jar \
        --output dex $(find obj -name '*.class')
    cp base.apk rastro-unsigned.apk && (cd dex && zip ../rastro-unsigned.apk classes.dex)
    $BT/zipalign -f -p 4 rastro-unsigned.apk rastro-aligned.apk
    $BT/apksigner sign --ks rastro.jks --ks-key-alias rastro \
        --ks-pass file:PASSFILE --key-pass file:PASSFILE2 --out rastro.apk rastro-aligned.apk

## Firma

La APK publicada se firma con un keystore propio y estable (NO esta en este
repo ni debe estarlo). El keystore vive cifrado fuera del repo y su contrasena
en un gestor de contrasenas; sin esa clave, las actualizaciones no se instalan
encima de la version publicada.
