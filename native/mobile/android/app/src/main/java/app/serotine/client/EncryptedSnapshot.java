package app.serotine.client;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** One authenticated, atomically replaced snapshot. No fallback to a new identity. */
final class EncryptedSnapshot {
    private static final String ALIAS = "serotine.snapshot.v1";
    private static final byte[] AAD = "serotine-native-snapshot-v1".getBytes(StandardCharsets.UTF_8);
    private final AtomicFile file;
    private final File initialized;
    private final KeyStore keyStore;
    EncryptedSnapshot(Context context) throws Exception {
        File directory = new File(context.getNoBackupFilesDir(), "identity-v1");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Persistent storage unavailable");
        file = new AtomicFile(new File(directory, "snapshot.enc"));
        initialized = new File(directory, "initialized");
        keyStore = KeyStore.getInstance("AndroidKeyStore"); keyStore.load(null);
    }
    static void reset(Context context) throws Exception {
        File directory = new File(context.getNoBackupFilesDir(), "identity-v1");
        deleteTree(directory);
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        if (keys.containsAlias(ALIAS)) keys.deleteEntry(ALIAS);
    }
    private static void deleteTree(File file) throws IOException {
        if (!file.exists()) return;
        File[] children = file.isDirectory() ? file.listFiles() : null;
        if (children != null) for (File child : children) deleteTree(child);
        if (!file.delete()) throw new IOException("Could not remove local storage");
    }
    private boolean exists() { return file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists(); }
    private SecretKey key(boolean create) throws Exception {
        SecretKey existing = (SecretKey) keyStore.getKey(ALIAS, null);
        if (existing != null) return existing;
        if (!create) throw new IOException("Local encryption key unavailable; restore an encrypted backup");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
    synchronized String read() throws Exception {
        if (!exists()) {
            if (initialized.exists() || keyStore.containsAlias(ALIAS)) throw new IOException("Local snapshot missing; restore an encrypted backup");
            return null;
        }
        byte[] sealed;
        try (InputStream input = file.openRead()) { sealed = SerotineNativePlugin.readBounded(input, NativePolicy.SNAPSHOT_LIMIT + 64); }
        if (sealed.length < 29 || sealed[0] != 1) throw new IOException("Invalid local snapshot");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Arrays.copyOfRange(sealed, 1, 13)));
        cipher.updateAAD(AAD);
        byte[] plain = cipher.doFinal(sealed, 13, sealed.length - 13);
        if (plain.length > NativePolicy.SNAPSHOT_LIMIT) throw new IOException("Snapshot too large");
        if (!initialized.exists() && !initialized.createNewFile()) throw new IOException("Storage marker unavailable");
        return new String(plain, StandardCharsets.UTF_8);
    }
    synchronized void write(String value) throws Exception {
        byte[] plain = value.getBytes(StandardCharsets.UTF_8);
        if (plain.length > NativePolicy.SNAPSHOT_LIMIT) throw new IOException("Local storage limit reached; export a backup and free space");
        // Never replace unreadable existing storage with newly generated data.
        if (exists()) read();
        else if (initialized.exists() || keyStore.containsAlias(ALIAS)) throw new IOException("Local snapshot missing; restore an encrypted backup");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(!exists())); cipher.updateAAD(AAD);
        byte[] sealed = cipher.doFinal(plain);
        FileOutputStream output = null;
        try {
            output = file.startWrite(); output.write(1); output.write(cipher.getIV()); output.write(sealed);
            file.finishWrite(output); output = null;
            if (!initialized.exists() && !initialized.createNewFile()) throw new IOException("Storage marker unavailable");
        } finally { if (output != null) file.failWrite(output); }
    }
}
