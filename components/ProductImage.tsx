import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Image, ImageStyle, StyleProp, View } from 'react-native';

export function ProductImage({ uri, style }: { uri?: string | null; style: StyleProp<ImageStyle> }) {
  const [failed, setFailed] = useState(false);
  if (!uri || failed) {
    return (
      <View style={[style as any, { backgroundColor: '#EDF2F7', alignItems: 'center', justifyContent: 'center' }]}>
        <Ionicons name="image-outline" size={32} color="#A0AEC0" />
      </View>
    );
  }
  return <Image source={{ uri }} style={[{ backgroundColor: '#fff' }, style]} resizeMode="contain" onError={() => setFailed(true)} />;
}
