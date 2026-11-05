import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'placeholder', {auth:{storage:AsyncStorage,autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}});
